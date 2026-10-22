package aifiles

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"strings"
	"testing"
	"time"
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
	p := &Preparer{Limits: Default, PDF: renderer}
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
