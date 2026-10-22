package aifiles

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/klippa-app/go-pdfium"
)

// makePDF builds a PDF whose page i is filled with colors[i] (r, g, b in 0..1).
func makePDF(colors [][3]float64) []byte {
	var b bytes.Buffer
	var offs []int
	obj := func(s string) {
		offs = append(offs, b.Len())
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", len(offs), s)
	}
	b.WriteString("%PDF-1.4\n")
	n := len(colors)
	kids := make([]string, n)
	for i := range colors {
		kids[i] = fmt.Sprintf("%d 0 R", 3+2*i)
	}
	obj("<< /Type /Catalog /Pages 2 0 R >>")
	obj(fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), n))
	for i, c := range colors {
		stream := fmt.Sprintf("%.2f %.2f %.2f rg 0 0 200 300 re f", c[0], c[1], c[2])
		obj(fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents %d 0 R >>", 4+2*i))
		obj(fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(stream), stream))
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(offs)+1)
	for _, o := range offs {
		fmt.Fprintf(&b, "%010d 00000 n \n", o)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offs)+1, xref)
	return b.Bytes()
}

func src(name, mime string, data []byte) Source {
	return Source{Name: name, Mime: mime, Size: int64(len(data)), Open: func(context.Context) (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(data)), nil
	}}
}

func pngOf(w, h int, c color.Color) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, c)
		}
	}
	var b bytes.Buffer
	_ = png.Encode(&b, img)
	return b.Bytes()
}

// centre is the colour in the middle of a prepared image.
func centre(t *testing.T, url string) (color.Color, image.Rectangle) {
	t.Helper()
	raw, err := DecodeDataURL(url)
	if err != nil {
		t.Fatal(err)
	}
	img, err := jpeg.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	b := img.Bounds()
	return img.At(b.Dx()/2, b.Dy()/2), b
}

func isRed(c color.Color) bool {
	r, g, b, _ := c.RGBA()
	return r > 0xd000 && g < 0x3000 && b < 0x3000
}

func isBlue(c color.Color) bool {
	r, g, b, _ := c.RGBA()
	return b > 0xd000 && r < 0x3000 && g < 0x3000
}

var renderer = &PDFium{Timeout: 60 * time.Second}

func TestPrepareImageResized(t *testing.T) {
	p := &Preparer{Limits: Default}
	out := p.Prepare(context.Background(), []Source{src("photo.png", "image/png", pngOf(3000, 1500, color.RGBA{255, 0, 0, 255}))})
	if len(out.Images) != 1 || out.Files[0].Content != ContentImage || out.Files[0].Images[0] != 1 {
		t.Fatalf("prepared %+v", out.Files)
	}
	c, b := centre(t, out.Images[0].DataURL)
	if b.Dx() != Default.MaxSide || b.Dy() != Default.MaxSide/2 || !isRed(c) {
		t.Fatalf("image %v %v", b, c)
	}
}

func TestPrepareImageBombAndGarbage(t *testing.T) {
	p := &Preparer{Limits: Limits{MaxImages: 4, MaxImageBytes: 5 << 20, MaxSide: 100, MaxSource: 1 << 20, MaxPixels: 1000}}
	out := p.Prepare(context.Background(), []Source{
		src("big.png", "image/png", pngOf(100, 100, color.White)), // 10 000 px > MaxPixels
		src("broken.jpg", "image/jpeg", []byte("not a jpeg")),
	})
	for _, f := range out.Files {
		if f.Content != ContentNone || f.Note != NoteUnreadable {
			t.Fatalf("%+v", f)
		}
	}
	if len(out.Images) != 0 {
		t.Fatal("images sent")
	}
}

func TestPreparePDF(t *testing.T) {
	if testing.Short() {
		t.Skip("PDFium runtime")
	}
	defer renderer.Close()
	// The content limits of production; no time budget (a slow -race runner renders slowly,
	// TestPrepareWarmNotCounted and TestPDFiumDeadlineKills cover the deadlines).
	l := Default
	l.MaxTime = 0
	p := &Preparer{Limits: l, PDF: renderer}
	red, green, blue := [3]float64{1, 0, 0}, [3]float64{0, 1, 0}, [3]float64{0, 0, 1}
	ctx := context.Background()

	// Several pages: the first and the last only.
	out := p.Prepare(ctx, []Source{src("act.pdf", "application/pdf", makePDF([][3]float64{red, green, green, blue}))})
	f := out.Files[0]
	if f.Content != ContentPages || f.Pages != 4 || len(f.Shown) != 2 || f.Shown[0] != 1 || f.Shown[1] != 4 || len(out.Images) != 2 {
		t.Fatalf("pages %+v", f)
	}
	if c, b := centre(t, out.Images[0].DataURL); !isRed(c) || b.Dy() != Default.MaxSide {
		t.Fatalf("first page %v %v", c, b)
	}
	if c, _ := centre(t, out.Images[1].DataURL); !isBlue(c) || out.Images[1].Page != 4 {
		t.Fatalf("last page %v", c)
	}

	// One page: it alone.
	out = p.Prepare(ctx, []Source{src("one.pdf", "application/pdf", makePDF([][3]float64{blue}))})
	if f := out.Files[0]; f.Pages != 1 || len(f.Shown) != 1 || len(out.Images) != 1 {
		t.Fatalf("one page %+v", f)
	}

	// Not a PDF: by name.
	out = p.Prepare(ctx, []Source{src("fake.pdf", "application/pdf", []byte("%PDF-1.4 garbage"))})
	if f := out.Files[0]; f.Content != ContentNone || f.Note != NoteUnreadable {
		t.Fatalf("garbage %+v", f)
	}

	// The image limit: 4 in all — a 4-page PDF (2), two images (2), then nothing more.
	img := pngOf(10, 10, color.RGBA{255, 0, 0, 255})
	out = p.Prepare(ctx, []Source{
		src("a.pdf", "application/pdf", makePDF([][3]float64{red, blue, blue})),
		src("1.png", "image/png", img), src("2.png", "image/png", img), src("3.png", "image/png", img),
		src("b.pdf", "application/pdf", makePDF([][3]float64{red})),
	})
	if len(out.Images) != 4 || out.Files[3].Note != NoteLimit || out.Files[4].Note != NoteLimit || out.Files[3].Content != ContentNone {
		t.Fatalf("limit %d %+v", len(out.Images), out.Files)
	}
	// With one image left, a PDF sends its first page only.
	out = p.Prepare(ctx, []Source{
		src("1.png", "image/png", img), src("2.png", "image/png", img), src("3.png", "image/png", img),
		src("c.pdf", "application/pdf", makePDF([][3]float64{red, blue})),
	})
	if f := out.Files[3]; len(out.Images) != 4 || len(f.Shown) != 1 || f.Shown[0] != 1 || f.Pages != 2 {
		t.Fatalf("last slot %+v", f)
	}
}

func TestPrepareBytesLimit(t *testing.T) {
	// A noisy image that cannot fit 2 KB even at the lowest quality and size.
	noise := image.NewRGBA(image.Rect(0, 0, 400, 400))
	for i := range noise.Pix {
		noise.Pix[i] = byte(i * 7919 % 251)
	}
	var b bytes.Buffer
	_ = png.Encode(&b, noise)
	p := &Preparer{Limits: Limits{MaxImages: 4, MaxImageBytes: 200, MaxSide: 400, MaxSource: 1 << 20, MaxPixels: 1 << 20}}
	out := p.Prepare(context.Background(), []Source{src("noise.png", "image/png", b.Bytes())})
	if len(out.Images) != 0 || out.Files[0].Note != NoteLimit {
		t.Fatalf("%+v", out.Files)
	}
	// Too large to read at all.
	p.Limits.MaxSource = 10
	out = p.Prepare(context.Background(), []Source{src("x.png", "image/png", b.Bytes())})
	if out.Files[0].Note != NoteTooLarge {
		t.Fatalf("%+v", out.Files)
	}
}

func TestPrepareText(t *testing.T) {
	p := &Preparer{Limits: Limits{MaxText: 13, MaxFileText: 10, MaxTextRead: 1 << 10}}
	out := p.Prepare(context.Background(), []Source{
		src("a.txt", "text/plain; charset=utf-8", []byte("привет\r\nмир\x00")), // NUL: binary
		src("notes.md", "text/markdown", []byte("Сумма\r\n100\u202e₽")),
		src("data.csv", "application/octet-stream", []byte("a,b,c,d,e,f")),
		src("more.txt", "text/plain", []byte("left over")),
		src("deal.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", []byte("PK")),
	})
	fs := out.Files
	if fs[0].Content != ContentNone || fs[0].Note != NoteUnreadable {
		t.Fatalf("binary %+v", fs[0])
	}
	if fs[1].Text != "Сумма\n100₽" || fs[1].Note != "" || fs[1].Type != "text/markdown" {
		t.Fatalf("md %q %q", fs[1].Text, fs[1].Note)
	}
	// 13 − 10 = 3 characters left of the request.
	if fs[2].Text != "a,b" || fs[2].Note != NoteTruncated {
		t.Fatalf("csv %+v", fs[2])
	}
	if fs[3].Content != ContentNone || fs[3].Note != NoteLimit {
		t.Fatalf("over the limit %+v", fs[3])
	}
	if fs[4].Content != ContentNone || fs[4].Note != NoteUnsupported {
		t.Fatalf("docx %+v", fs[4])
	}
	// Read only the first MaxTextRead bytes: cut.
	p.Limits = Limits{MaxText: 100, MaxFileText: 100, MaxTextRead: 4}
	if f := p.Prepare(context.Background(), []Source{src("x.log", "text/plain", []byte("abcdefgh"))}).Files[0]; f.Text != "abcd" || f.Note != NoteTruncated {
		t.Fatalf("read cut %+v", f)
	}
}

func TestWithoutImages(t *testing.T) {
	p := Prepared{
		Files:  []File{{Name: "a.png", Content: ContentImage, Images: []int{1}}, {Name: "b.txt", Content: ContentText, Text: "x"}},
		Images: []Image{{File: 0, DataURL: "data:"}},
	}
	q := p.WithoutImages()
	if len(q.Images) != 0 || q.Files[0].Content != ContentNone || q.Files[0].Note != NoteNoImages || q.Files[1].Text != "x" {
		t.Fatalf("%+v", q)
	}
	if p.Files[0].Content != ContentImage {
		t.Fatal("the original changed")
	}
}

// A document over the deadline kills its module: the call returns soon after the deadline, and
// the next document renders in a fresh instance.
func TestPDFiumDeadlineKills(t *testing.T) {
	if testing.Short() {
		t.Skip("PDFium runtime")
	}
	r := &PDFium{Timeout: 60 * time.Second}
	defer r.Close()
	ctx := context.Background()
	if _, _, err := r.FirstLast(ctx, makePDF([][3]float64{{1, 0, 0}}), 100, 1); err != nil { // compile the runtime
		t.Fatal(err)
	}
	// A page of 300 000 tiny filled paths: far longer to render than the deadline.
	var s strings.Builder
	s.WriteString("0 0 1 rg ")
	for i := range 300_000 {
		fmt.Fprintf(&s, "%d %d 0.5 0.5 re f ", i%600, (i/600)%800)
	}
	stream := s.String()
	heavy := bytes.Replace(makePDF([][3]float64{{0, 0, 0}}), []byte("0.00 0.00 0.00 rg 0 0 200 300 re f"), []byte(stream), 1)
	heavy = bytes.Replace(heavy, []byte(fmt.Sprintf("/Length %d", len("0.00 0.00 0.00 rg 0 0 200 300 re f"))), []byte(fmt.Sprintf("/Length %d", len(stream))), 1)
	dl, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, _, err := r.FirstLast(dl, heavy, 1568, 1)
	if err == nil {
		t.Skip("the heavy page rendered within the deadline on this machine")
	}
	el := time.Since(start)
	if el > 5*time.Second {
		t.Fatalf("the render held %v past a 300 ms deadline", el)
	}
	t.Logf("killed after %v: %v", el, err)
	n, pages, err := r.FirstLast(ctx, makePDF([][3]float64{{1, 0, 0}, {0, 0, 1}}), 100, 2)
	if err != nil || n != 2 || len(pages) != 2 {
		t.Fatalf("after a kill: %d %d %v", n, len(pages), err)
	}
}

// slowPDF is a renderer whose cold start takes warm; rendering is instant.
type slowPDF struct {
	warm   time.Duration
	warmed bool
}

func (s *slowPDF) Warm(ctx context.Context) error {
	select {
	case <-time.After(s.warm):
		s.warmed = true
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *slowPDF) FirstLast(ctx context.Context, _ []byte, _, _ int) (int, []image.Image, error) {
	if !s.warmed || ctx.Err() != nil {
		return 0, nil, errors.New("not ready")
	}
	return 1, []image.Image{image.NewRGBA(image.Rect(0, 0, 10, 10))}, nil
}

// The renderer's cold start is not the files' time: a warm-up longer than MaxTime still renders.
func TestPrepareWarmNotCounted(t *testing.T) {
	r := &slowPDF{warm: 300 * time.Millisecond}
	p := &Preparer{Limits: Limits{MaxImages: 4, MaxImageBytes: 5 << 20, MaxSide: 100, MaxSource: 1 << 20, MaxPixels: 1 << 20, MaxTime: 100 * time.Millisecond}, PDF: r}
	out := p.Prepare(context.Background(), []Source{src("a.pdf", "application/pdf", []byte("%PDF"))})
	if f := out.Files[0]; f.Content != ContentPages || len(out.Images) != 1 {
		t.Fatalf("%+v", f)
	}
}

// A request that gives up waiting for the compile does not stop it: the next one finds the
// runtime ready, compiled once.
func TestPDFiumColdStartOutlivesRequest(t *testing.T) {
	if testing.Short() {
		t.Skip("PDFium runtime")
	}
	orig := initRuntime
	var compiles atomic.Int32
	initRuntime = func() (pdfium.Pool, error) {
		compiles.Add(1)
		time.Sleep(300 * time.Millisecond)
		return orig()
	}
	defer func() { initRuntime = orig }()
	r := &PDFium{Timeout: 60 * time.Second}
	defer r.Close()
	short, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, _, err := r.FirstLast(short, makePDF([][3]float64{{1, 0, 0}}), 100, 1); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a request shorter than the cold start: %v", err)
	}
	n, pages, err := r.FirstLast(context.Background(), makePDF([][3]float64{{1, 0, 0}, {0, 0, 1}}), 100, 2)
	if err != nil || n != 2 || len(pages) != 2 || compiles.Load() != 1 {
		t.Fatalf("after: %d %d %v, %d compiles", n, len(pages), err, compiles.Load())
	}
}

// Failed reads spend MaxReads too: 20 broken files cannot hold the decoder 20 times.
func TestPrepareReadsBudget(t *testing.T) {
	opened := 0
	broken := Source{Name: "x.png", Mime: "image/png", Size: 10, Open: func(context.Context) (io.ReadCloser, error) {
		opened++
		return io.NopCloser(strings.NewReader("not a png!")), nil
	}}
	srcs := make([]Source, 20)
	for i := range srcs {
		srcs[i] = broken
	}
	srcs = append(srcs, src("ok.png", "image/png", pngOf(10, 10, color.White)))
	p := &Preparer{Limits: Limits{MaxImages: 4, MaxImageBytes: 5 << 20, MaxSide: 100, MaxSource: 1 << 20, MaxPixels: 1 << 20, MaxReads: 3}}
	out := p.Prepare(context.Background(), srcs)
	if opened != 3 || len(out.Images) != 0 || out.Files[3].Note != NoteLimit || out.Files[20].Note != NoteLimit {
		t.Fatalf("opened %d, images %d, %+v", opened, len(out.Images), out.Files[3])
	}
}

// The decoded size counts the colour model: a 16-bit image needs 8 bytes a pixel.
func TestPrepareDecodeBytes(t *testing.T) {
	img := image.NewNRGBA64(image.Rect(0, 0, 100, 100))
	var b bytes.Buffer
	_ = png.Encode(&b, img)
	p := &Preparer{Limits: Limits{MaxImages: 4, MaxImageBytes: 5 << 20, MaxSide: 100, MaxSource: 1 << 20, MaxPixels: 1 << 20, MaxDecodeBytes: 100 * 100 * 4}}
	if out := p.Prepare(context.Background(), []Source{src("deep.png", "image/png", b.Bytes())}); out.Files[0].Note != NoteUnreadable {
		t.Fatalf("16-bit %+v", out.Files[0])
	}
	if out := p.Prepare(context.Background(), []Source{src("rgba.png", "image/png", pngOf(100, 100, color.White))}); out.Files[0].Content != ContentImage {
		t.Fatalf("8-bit %+v", out.Files[0])
	}
}

func TestProgressiveJPEG(t *testing.T) {
	app0 := []byte{0xFF, 0xE0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0}
	frame := func(sof byte) []byte {
		b := append([]byte{0xFF, 0xD8}, app0...)
		return append(b, 0xFF, sof, 0x00, 0x0B, 8, 0, 16, 0, 16, 1, 1, 0x11, 0, 0xFF, 0xD9)
	}
	if !progressiveJPEG(frame(0xC2)) || progressiveJPEG(frame(0xC0)) || progressiveJPEG([]byte("not a jpeg")) {
		t.Fatal("progressive detection")
	}
	var b bytes.Buffer
	_ = jpeg.Encode(&b, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil)
	if progressiveJPEG(b.Bytes()) {
		t.Fatal("a baseline JPEG of image/jpeg")
	}
}

// One owner at a time: a second request of the same person waits and, past MaxTime, sends the
// files by name; another person is not held.
func TestPrepareForOwner(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{})
	slow := Source{Name: "slow.png", Mime: "image/png", Size: 10, Open: func(context.Context) (io.ReadCloser, error) {
		close(started)
		<-release
		return io.NopCloser(bytes.NewReader(pngOf(10, 10, color.White))), nil
	}}
	p := &Preparer{Limits: Limits{MaxImages: 4, MaxImageBytes: 5 << 20, MaxSide: 100, MaxSource: 1 << 20, MaxPixels: 1 << 20,
		MaxText: 100, MaxFileText: 100, MaxTextRead: 100, MaxTime: 200 * time.Millisecond}}
	done := make(chan Prepared)
	go func() { done <- p.PrepareFor(context.Background(), "alice", []Source{slow}) }()
	<-started
	out := p.PrepareFor(context.Background(), "alice", []Source{src("a.png", "image/png", pngOf(10, 10, color.White))})
	if out.Files[0].Note != NoteLimit || len(out.Images) != 0 {
		t.Fatalf("second request of alice %+v", out.Files)
	}
	out = p.PrepareFor(context.Background(), "bob", []Source{src("b.txt", "text/plain", []byte("hi"))})
	if out.Files[0].Text != "hi" {
		t.Fatalf("bob %+v", out.Files)
	}
	close(release)
	<-done
	out = p.PrepareFor(context.Background(), "alice", []Source{src("a.txt", "text/plain", []byte("again"))})
	if out.Files[0].Text != "again" {
		t.Fatalf("alice after %+v", out.Files)
	}
}
