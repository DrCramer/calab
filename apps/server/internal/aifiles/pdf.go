package aifiles

import (
	"context"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"io"
	"sync"
	"time"

	"github.com/klippa-app/go-pdfium"
	"github.com/klippa-app/go-pdfium/requests"
	"github.com/klippa-app/go-pdfium/webassembly"
	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/experimental"
)

// PDFium renders PDF pages with PDFium compiled to WebAssembly (go-pdfium on wazero): pure Go,
// no cgo, no extra binary in the image (ADR-0123). The runtime is compiled on the first PDF and
// closed after Idle without one, so a server that never sees a PDF never pays for it. One
// document at a time, each in a fresh module instance (no state carried between documents),
// with no filesystem, bounded memory and a deadline (Timeout).
type PDFium struct {
	Timeout time.Duration // one document; 0 = 20 s
	Idle    time.Duration // the runtime is closed after this long unused; 0 = 5 min

	mu    sync.Mutex
	pool  pdfium.Pool
	users int
	idle  *time.Timer
	one   chan struct{} // one document at a time
	once  sync.Once
}

// memoryPages bounds the module's memory: 4096 × 64 KiB = 256 MiB.
const memoryPages = 4096

// errBusy: another document is being rendered for longer than the caller waits.
var errBusy = errors.New("aifiles: PDF renderer busy")

func (p *PDFium) acquire(ctx context.Context) (pdfium.Pool, error) {
	p.once.Do(func() { p.one = make(chan struct{}, 1) })
	wait, cancel := context.WithTimeout(ctx, p.timeout())
	defer cancel()
	select {
	case p.one <- struct{}{}:
	case <-wait.Done():
		return nil, errBusy
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.idle != nil {
		p.idle.Stop()
	}
	if p.pool == nil {
		pool, err := webassembly.Init(webassembly.Config{
			MinIdle: 0, MaxIdle: 1, MaxTotal: 1,
			FSConfig: wazero.NewFSConfig(), // no host directory is mounted
			RuntimeConfig: wazero.NewRuntimeConfig().
				WithCoreFeatures(api.CoreFeaturesV2 | experimental.CoreFeaturesExceptionHandling).
				WithMemoryLimitPages(memoryPages).
				WithCloseOnContextDone(true),
			Stdout: io.Discard, Stderr: io.Discard,
		})
		if err != nil {
			<-p.one
			return nil, err
		}
		p.pool = pool
	}
	p.users++
	return p.pool, nil
}

func (p *PDFium) release() {
	p.mu.Lock()
	p.users--
	if p.users == 0 && p.pool != nil {
		idle := p.Idle
		if idle <= 0 {
			idle = 5 * time.Minute
		}
		p.idle = time.AfterFunc(idle, p.closeIdle)
	}
	p.mu.Unlock()
	<-p.one
}

func (p *PDFium) closeIdle() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.users == 0 && p.pool != nil {
		_ = p.pool.Close()
		p.pool = nil
	}
}

// Close closes the runtime (shutdown, tests).
func (p *PDFium) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.idle != nil {
		p.idle.Stop()
	}
	if p.pool != nil {
		_ = p.pool.Close()
		p.pool = nil
	}
}

func (p *PDFium) timeout() time.Duration {
	if p.Timeout > 0 {
		return p.Timeout
	}
	return 20 * time.Second
}

// FirstLast implements PDF.
func (p *PDFium) FirstLast(ctx context.Context, data []byte, maxSide, want int) (n int, out []image.Image, err error) {
	pool, err := p.acquire(ctx)
	if err != nil {
		return 0, nil, err
	}
	defer p.release()
	inst, err := pool.GetInstance(p.timeout())
	if err != nil {
		return 0, nil, err
	}
	// The deadline kills the module (WithCloseOnContextDone): a hostile PDF cannot hold the
	// renderer.
	dl, cancel := context.WithTimeout(ctx, p.timeout())
	defer cancel()
	stop := context.AfterFunc(dl, func() { _ = inst.Kill() })
	defer func() {
		if stop() {
			_ = inst.Close()
		}
		if r := recover(); r != nil {
			n, out, err = 0, nil, errors.New("aifiles: PDF render failed")
		}
	}()

	doc, err := inst.OpenDocument(&requests.OpenDocument{File: &data})
	if err != nil {
		return 0, nil, err
	}
	defer func() { _, _ = inst.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document}) }()
	cnt, err := inst.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc.Document})
	if err != nil {
		return 0, nil, err
	}
	n = cnt.PageCount
	if n < 1 {
		return 0, nil, errors.New("aifiles: PDF without pages")
	}
	idx := []int{0}
	if want > 1 && n > 1 {
		idx = append(idx, n-1)
	}
	for _, i := range idx {
		r, err := inst.RenderPageInPixels(&requests.RenderPageInPixels{
			Page:  requests.Page{ByIndex: &requests.PageByIndex{Document: doc.Document, Index: i}},
			Width: maxSide, Height: maxSide,
		})
		if err != nil {
			return 0, nil, err
		}
		out = append(out, flatten(r.Result.RenderedImage))
		r.Cleanup()
	}
	return n, out, nil
}

// flatten copies a rendered page (its buffer lives in the module) onto white.
func flatten(src image.Image) image.Image {
	b := src.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(dst, dst.Bounds(), src, b.Min, draw.Over)
	return dst
}
