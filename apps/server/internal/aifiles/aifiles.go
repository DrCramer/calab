// Package aifiles prepares the attached files of a smart task for the model (CBF-75, ADR-0123):
// images become JPEGs (resized), a PDF its first and last page rendered to JPEG, text files
// their text; everything else only its name and type. Every limit — the number of images, their
// total size, the characters of text, the bytes read of a file — is applied here, so a request
// never sends the provider more than Limits allow. The content is untrusted data for the model
// and is never logged.
package aifiles

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image"
	"image/color"
	"image/draw"
	_ "image/gif" // decoders of image.Decode
	"image/jpeg"
	_ "image/png" // decoders of image.Decode
	"io"
	"mime"
	"path"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // the WebP decoder of image.Decode
)

// Limits bound what one request sends the model.
type Limits struct {
	MaxImages     int   // images in all (a PDF page counts as one)
	MaxImageBytes int   // bytes of all the images' data: URLs (base64)
	MaxSide       int   // pixels of the longer side of an image sent
	MaxText       int   // characters of text of all files
	MaxFileText   int   // characters of text of one file
	MaxSource     int64 // bytes of an image or PDF read (bigger ones: name only)
	MaxTextRead   int64 // bytes of a text file read
	MaxPixels     int   // pixels of a source image decoded (decompression bombs)
	// MaxDecodeBytes bounds the memory of one decoded source image (pixels × bytes per pixel
	// of its colour model): a 16-bit 50 MP PNG would need 400 MB.
	MaxDecodeBytes int
	// MaxReads is the images and PDFs read and decoded or rendered per request, failed ones
	// included: a request of 20 hostile files cannot hold the decoder or the PDF renderer 20
	// times (only successes spend MaxImages).
	MaxReads int
	// MaxTime bounds the whole Prepare; files left when it is up go by name (NoteLimit).
	MaxTime time.Duration
}

// Default is the production limits: up to 4 images, ~5 MB of them, 1568 px; 20 000 characters
// of text, 8 000 a file; 6 images or PDFs read, 30 s in all.
var Default = Limits{
	MaxImages: 4, MaxImageBytes: 5 << 20, MaxSide: 1568,
	MaxText: 20000, MaxFileText: 8000,
	MaxSource: 25 << 20, MaxTextRead: 256 << 10, MaxPixels: 50_000_000,
	MaxDecodeBytes: 256 << 20, MaxReads: 6, MaxTime: 30 * time.Second,
}

// Content kinds of File.Content.
const (
	ContentImage = "image" // the file is one image sent
	ContentPages = "pages" // a PDF: Shown pages sent as images
	ContentText  = "text"  // Text is the file's text
	ContentNone  = "none"  // only the name and type
)

// Notes of File.Note: why the content is missing or cut.
const (
	NoteTruncated   = "truncated"   // the text is cut
	NoteLimit       = "limit"       // the request's limit of images or text was reached
	NoteTooLarge    = "too_large"   // the file is bigger than MaxSource
	NoteUnreadable  = "unreadable"  // the file could not be decoded (or a PDF rendered)
	NoteUnsupported = "unsupported" // a type whose content is not sent
	NoteNoImages    = "no_images"   // the model does not take images (WithoutImages)
)

// Source is one attached file.
type Source struct {
	Name string
	Mime string
	Size int64
	Open func(ctx context.Context) (io.ReadCloser, error)
}

// File is what the model is told about one file (the JSON of its data message).
type File struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	Type    string `json:"type"`
	Content string `json:"content"`
	Text    string `json:"text,omitempty"`
	Pages   int    `json:"pages,omitempty"`       // a PDF's page count
	Shown   []int  `json:"shown_pages,omitempty"` // the PDF's pages sent (1-based)
	Images  []int  `json:"images,omitempty"`      // numbers of the images of this file (1-based, in order)
	Note    string `json:"note,omitempty"`
}

// Image is one image sent: a JPEG as a data: URL.
type Image struct {
	File    int // index in Prepared.Files
	Page    int // 1-based PDF page, 0 = an image file
	DataURL string
}

// Prepared is the files of one request.
type Prepared struct {
	Files  []File
	Images []Image
}

// WithoutImages is p for a model that does not take images: images are dropped, the files that
// had them say so (NoteNoImages); text stays.
func (p Prepared) WithoutImages() Prepared {
	out := Prepared{Files: make([]File, len(p.Files))}
	for i, f := range p.Files {
		if f.Content == ContentImage || f.Content == ContentPages {
			f.Content, f.Shown, f.Images, f.Note = ContentNone, nil, nil, NoteNoImages
		}
		out.Files[i] = f
	}
	return out
}

// PDF renders pages of a PDF.
type PDF interface {
	// FirstLast returns the page count and, rendered to fit maxSide × maxSide, the first page
	// and — when want is 2 and there are several — the last one.
	FirstLast(ctx context.Context, data []byte, maxSide, want int) (int, []image.Image, error)
}

// Preparer prepares files; PDF nil = PDFs are names only. It is shared by all requests of the
// process: one owner's requests are prepared one at a time (PrepareFor), and one image is
// decoded at a time in the process (MaxDecodeBytes bounds it), so concurrent requests cannot
// multiply the memory of decoding.
type Preparer struct {
	Limits Limits
	PDF    PDF

	once   sync.Once
	decode chan struct{} // one image decoded at a time
	mu     sync.Mutex
	owners map[string]chan struct{} // the owners being prepared for
}

func (p *Preparer) init() {
	p.once.Do(func() {
		p.decode = make(chan struct{}, 1)
		p.owners = map[string]chan struct{}{}
	})
}

// budget is what is left of the request's limits.
type budget struct {
	images, imageBytes, text, reads int
}

// Prepare reads srcs in order. A file that does not fit the limits left is sent by name (with a
// Note); a failure to read one never fails the request.
func (p *Preparer) Prepare(ctx context.Context, srcs []Source) Prepared {
	p.init()
	l := p.Limits
	p.warm(ctx, srcs)
	if l.MaxTime > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, l.MaxTime)
		defer cancel()
	}
	b := budget{images: l.MaxImages, imageBytes: l.MaxImageBytes, text: l.MaxText, reads: l.MaxReads}
	if l.MaxReads <= 0 {
		b.reads = len(srcs)
	}
	var out Prepared
	for _, src := range srcs {
		f := File{Name: src.Name, Size: src.Size, Type: baseMime(src.Mime), Content: ContentNone}
		switch k := kindOf(f.Type, src.Name); {
		case ctx.Err() != nil && k != kindOther:
			f.Note = NoteLimit // the time is up
		case k == kindImage:
			p.image(ctx, src, &f, &b, &out)
		case k == kindPDF:
			p.pdf(ctx, src, &f, &b, &out)
		case k == kindText:
			p.text(ctx, src, &f, &b)
		default:
			f.Note = NoteUnsupported
		}
		out.Files = append(out.Files, f)
	}
	return out
}

// warmer is a PDF renderer with a cold start (PDFium: the runtime's compile).
type warmer interface {
	Warm(ctx context.Context) error
}

// warm makes the PDF renderer ready before MaxTime starts when srcs have a PDF: a cold start
// (seconds, more on a slow node) is not the files' time. ctx (the request) bounds the wait; a
// failure leaves the PDFs to fail on their own (by name).
func (p *Preparer) warm(ctx context.Context, srcs []Source) {
	w, ok := p.PDF.(warmer)
	if !ok {
		return
	}
	for _, src := range srcs {
		if kindOf(baseMime(src.Mime), src.Name) == kindPDF && src.Size <= p.Limits.MaxSource {
			_ = w.Warm(ctx)
			return
		}
	}
}

// PrepareFor is Prepare for one owner (a person): their requests are prepared one after
// another, so one person cannot occupy the decoder or the PDF renderer with many parallel
// requests. A request that waits past Limits.MaxTime (or its context) sends the files by name.
func (p *Preparer) PrepareFor(ctx context.Context, owner string, srcs []Source) Prepared {
	p.init()
	if len(srcs) == 0 {
		return Prepared{}
	}
	wait := ctx
	if p.Limits.MaxTime > 0 {
		var cancel context.CancelFunc
		wait, cancel = context.WithTimeout(ctx, p.Limits.MaxTime)
		defer cancel()
	}
	for {
		p.mu.Lock()
		busy, ok := p.owners[owner]
		if !ok {
			done := make(chan struct{})
			p.owners[owner] = done
			p.mu.Unlock()
			defer func() {
				p.mu.Lock()
				delete(p.owners, owner)
				p.mu.Unlock()
				close(done)
			}()
			return p.Prepare(ctx, srcs)
		}
		p.mu.Unlock()
		select {
		case <-busy:
		case <-wait.Done():
			return byName(srcs, NoteLimit)
		}
	}
}

// byName is srcs by name only, each with note (content kinds; the others NoteUnsupported).
func byName(srcs []Source, note string) Prepared {
	var out Prepared
	for _, src := range srcs {
		f := File{Name: src.Name, Size: src.Size, Type: baseMime(src.Mime), Content: ContentNone, Note: note}
		if kindOf(f.Type, src.Name) == kindOther {
			f.Note = NoteUnsupported
		}
		out.Files = append(out.Files, f)
	}
	return out
}

func (p *Preparer) image(ctx context.Context, src Source, f *File, b *budget, out *Prepared) {
	if b.images < 1 || b.reads < 1 {
		f.Note = NoteLimit
		return
	}
	b.reads--
	// One image in memory at a time in the process: read, decode, encode.
	select {
	case p.decode <- struct{}{}:
	case <-ctx.Done():
		f.Note = NoteLimit
		return
	}
	defer func() { <-p.decode }()
	data, note := p.read(ctx, src)
	if note != "" {
		f.Note = note
		return
	}
	img, err := p.decodeImage(data)
	if err != nil {
		f.Note = NoteUnreadable
		return
	}
	url, ok := fit(img, p.Limits.MaxSide, b.imageBytes)
	if !ok {
		f.Note = NoteLimit
		return
	}
	b.images--
	b.imageBytes -= len(url)
	out.Images = append(out.Images, Image{File: len(out.Files), DataURL: url})
	f.Content, f.Images = ContentImage, []int{len(out.Images)}
}

func (p *Preparer) pdf(ctx context.Context, src Source, f *File, b *budget, out *Prepared) {
	if p.PDF == nil {
		f.Note = NoteUnsupported
		return
	}
	if b.images < 1 || b.reads < 1 {
		f.Note = NoteLimit
		return
	}
	b.reads--
	data, note := p.read(ctx, src)
	if note != "" {
		f.Note = note
		return
	}
	// The first and the last page (one page: just it); with one image left, the first only.
	n, pages, err := p.PDF.FirstLast(ctx, data, p.Limits.MaxSide, min(2, b.images))
	if err != nil || n < 1 || len(pages) == 0 {
		f.Note = NoteUnreadable
		return
	}
	f.Pages = n
	nums := []int{1, n}
	if n == 1 {
		nums = nums[:1]
	}
	for i, img := range pages {
		if i >= len(nums) {
			break
		}
		if b.images < 1 {
			f.Note = NoteLimit
			break
		}
		url, ok := fit(img, p.Limits.MaxSide, b.imageBytes)
		if !ok {
			f.Note = NoteLimit
			break
		}
		b.images--
		b.imageBytes -= len(url)
		out.Images = append(out.Images, Image{File: len(out.Files), Page: nums[i], DataURL: url})
		f.Shown = append(f.Shown, nums[i])
		f.Images = append(f.Images, len(out.Images))
	}
	if len(f.Shown) > 0 {
		f.Content = ContentPages
	}
}

func (p *Preparer) text(ctx context.Context, src Source, f *File, b *budget) {
	if b.text < 1 {
		f.Note = NoteLimit
		return
	}
	rc, err := src.Open(ctx)
	if err != nil {
		f.Note = NoteUnreadable
		return
	}
	defer func() { _ = rc.Close() }()
	raw, err := io.ReadAll(io.LimitReader(rc, p.Limits.MaxTextRead))
	if err != nil || bytes.IndexByte(raw, 0) >= 0 { // NUL: binary after all
		f.Note = NoteUnreadable
		return
	}
	s := cleanText(raw)
	if s == "" {
		return
	}
	n := min(p.Limits.MaxFileText, b.text)
	cut := int64(len(raw)) < src.Size // only the first MaxTextRead bytes were read
	if utf8.RuneCountInString(s) > n {
		s, cut = string([]rune(s)[:n]), true
	}
	b.text -= utf8.RuneCountInString(s)
	f.Content, f.Text = ContentText, s
	if cut {
		f.Note = NoteTruncated
	}
}

// read reads an image or a PDF whole (≤ MaxSource).
func (p *Preparer) read(ctx context.Context, src Source) ([]byte, string) {
	if src.Size > p.Limits.MaxSource {
		return nil, NoteTooLarge
	}
	rc, err := src.Open(ctx)
	if err != nil {
		return nil, NoteUnreadable
	}
	defer func() { _ = rc.Close() }()
	data, err := io.ReadAll(io.LimitReader(rc, p.Limits.MaxSource+1))
	if err != nil {
		return nil, NoteUnreadable
	}
	if int64(len(data)) > p.Limits.MaxSource {
		return nil, NoteTooLarge
	}
	return data, ""
}

var errTooBig = errors.New("aifiles: image too large")

// decodeImage decodes an image after checking its dimensions and the memory its decoding takes
// (no decompression bombs).
func (p *Preparer) decodeImage(data []byte) (image.Image, error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if cfg.Width < 1 || cfg.Height < 1 || cfg.Width > 20000 || cfg.Height > 20000 || cfg.Width*cfg.Height > p.Limits.MaxPixels {
		return nil, errTooBig
	}
	bpp := bytesPerPixel(cfg.ColorModel)
	if progressiveJPEG(data) {
		bpp *= 5 // image/jpeg keeps every component's coefficients too: 4 bytes a sample
	}
	if m := p.Limits.MaxDecodeBytes; m > 0 && cfg.Width*cfg.Height*bpp > m {
		return nil, errTooBig
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	return img, err
}

// progressiveJPEG: data is a JPEG whose frame is progressive (SOF2, SOF6, SOF10, SOF14) — its
// decoding holds the coefficients of the whole image.
func progressiveJPEG(data []byte) bool {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return false
	}
	for i := 2; i+3 < len(data); {
		if data[i] != 0xFF {
			return false
		}
		m := data[i+1]
		switch {
		case m == 0xFF: // fill byte
			i++
			continue
		case m == 0xD8 || m == 0x01 || (m >= 0xD0 && m <= 0xD7): // no length
			i += 2
			continue
		case m >= 0xC0 && m <= 0xCF && m != 0xC4 && m != 0xC8 && m != 0xCC: // a frame
			return m == 0xC2 || m == 0xC6 || m == 0xCA || m == 0xCE
		case m == 0xDA || m == 0xD9: // scan or end before a frame
			return false
		}
		i += 2 + (int(data[i+2])<<8 | int(data[i+3]))
	}
	return false
}

// bytesPerPixel is the memory per pixel of a decoded image of model (an upper bound).
func bytesPerPixel(m color.Model) int {
	switch m {
	case color.RGBA64Model, color.NRGBA64Model:
		return 8
	case color.Gray16Model:
		return 2
	case color.GrayModel, color.AlphaModel:
		return 1
	case color.YCbCrModel:
		return 3 // 4:4:4 at most
	}
	if _, ok := m.(color.Palette); ok {
		return 1
	}
	return 4 // RGBA, NRGBA, CMYK, NYCbCrA (≤ 4), anything else
}

// fit encodes img as a JPEG data: URL no longer than room bytes: the longer side ≤ maxSide,
// then smaller and at a lower quality while it does not fit; false = it never fits.
func fit(img image.Image, maxSide, room int) (string, bool) {
	side := maxSide
	for _, q := range []int{82, 70, 60, 50} {
		url, err := encode(img, side, q)
		if err != nil {
			return "", false
		}
		if len(url) <= room {
			return url, true
		}
		side = side * 3 / 4
	}
	return "", false
}

const dataURLPrefix = "data:image/jpeg;base64,"

// encode scales img to fit side × side (never up), flattens it on white and encodes a JPEG.
func encode(img image.Image, side, quality int) (string, error) {
	r := img.Bounds()
	w, h := r.Dx(), r.Dy()
	if w > side || h > side {
		if w >= h {
			h, w = max(1, h*side/w), side
		} else {
			w, h = max(1, w*side/h), side
		}
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	if w == r.Dx() && h == r.Dy() {
		draw.Draw(dst, dst.Bounds(), img, r.Min, draw.Over)
	} else {
		xdraw.BiLinear.Scale(dst, dst.Bounds(), img, r, draw.Over, nil)
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: quality}); err != nil {
		return "", err
	}
	return dataURLPrefix + base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

// DecodeDataURL is the JPEG of a data: URL made here (tests).
func DecodeDataURL(url string) ([]byte, error) {
	if !strings.HasPrefix(url, dataURLPrefix) {
		return nil, errors.New("aifiles: not a JPEG data URL")
	}
	return base64.StdEncoding.DecodeString(strings.TrimPrefix(url, dataURLPrefix))
}

type kind int

const (
	kindOther kind = iota
	kindImage
	kindPDF
	kindText
)

// textExt are extensions read as text whatever their stored type.
var textExt = map[string]bool{
	".txt": true, ".md": true, ".markdown": true, ".csv": true, ".tsv": true, ".json": true, ".log": true,
	".yaml": true, ".yml": true, ".xml": true, ".ini": true, ".toml": true, ".conf": true, ".cfg": true,
	".html": true, ".htm": true, ".sql": true, ".go": true, ".py": true, ".js": true, ".ts": true,
	".tsx": true, ".jsx": true, ".java": true, ".kt": true, ".swift": true, ".c": true, ".h": true,
	".cpp": true, ".cs": true, ".rb": true, ".php": true, ".sh": true, ".rs": true, ".proto": true,
	".env.example": true, ".srt": true, ".vtt": true, ".eml": true,
}

func kindOf(mimeType, name string) kind {
	ext := strings.ToLower(path.Ext(name))
	switch {
	case mimeType == "image/jpeg", mimeType == "image/png", mimeType == "image/gif", mimeType == "image/webp":
		return kindImage
	case mimeType == "application/pdf" || (ext == ".pdf" && mimeType == "application/octet-stream"):
		return kindPDF
	case strings.HasPrefix(mimeType, "text/"), mimeType == "application/json", mimeType == "application/xml",
		mimeType == "application/x-yaml", mimeType == "application/yaml", mimeType == "application/csv":
		return kindText
	case textExt[ext] && (mimeType == "application/octet-stream" || mimeType == ""):
		return kindText
	}
	return kindOther
}

func baseMime(m string) string {
	if t, _, err := mime.ParseMediaType(m); err == nil {
		return t
	}
	return "application/octet-stream"
}

// cleanText is valid UTF-8 without control characters but newlines and tabs, \r\n as \n.
func cleanText(raw []byte) string {
	s := strings.ToValidUTF8(string(raw), "")
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.Map(func(r rune) rune {
		switch {
		case r == '\n' || r == '\t':
			return r
		case r == '\r':
			return '\n'
		case unicode.IsControl(r), r == '\uFEFF', unicode.Is(unicode.Bidi_Control, r):
			return -1
		}
		return r
	}, s)
	return strings.TrimSpace(s)
}
