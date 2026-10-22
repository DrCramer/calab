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
// no cgo, no extra binary in the image (ADR-0123). The runtime is compiled on the first PDF
// (Warm) and closed after Idle without one, so a server that never sees a PDF never pays for
// it. The compile is a cold start, not a document's time: it runs in the background, is shared
// by every waiter and is never cut by a request's deadline (a slow node finishes it for the next
// request). One document at a time, each in a fresh module instance (no state carried between
// documents), with no filesystem, bounded memory and a deadline (Timeout) that kills it.
type PDFium struct {
	Timeout time.Duration // one document; 0 = 20 s
	Idle    time.Duration // the runtime is closed after this long unused; 0 = 5 min

	mu    sync.Mutex
	cur   *runtimeGen // the runtime being compiled or ready; nil = none
	users int
	idle  *time.Timer
	one   chan struct{} // one document at a time
	once  sync.Once
}

// runtimeGen is one compile of the runtime: done closes when pool or err is set.
type runtimeGen struct {
	done chan struct{}
	pool pdfium.Pool
	err  error
}

// memoryPages bounds the module's memory: 4096 × 64 KiB = 256 MiB.
const memoryPages = 4096

// errBusy: another document is being rendered for longer than the caller waits.
var errBusy = errors.New("aifiles: PDF renderer busy")

// initRuntime compiles the runtime (a variable for tests).
var initRuntime = func() (pdfium.Pool, error) {
	return webassembly.Init(webassembly.Config{
		MinIdle: 0, MaxIdle: 1, MaxTotal: 1,
		FSConfig: wazero.NewFSConfig(), // no host directory is mounted
		RuntimeConfig: wazero.NewRuntimeConfig().
			WithCoreFeatures(api.CoreFeaturesV2 | experimental.CoreFeaturesExceptionHandling).
			WithMemoryLimitPages(memoryPages).
			WithCloseOnContextDone(true),
		Stdout: io.Discard, Stderr: io.Discard,
	})
}

// startLocked returns the current compile, starting one when there is none (p.mu held).
func (p *PDFium) startLocked() *runtimeGen {
	if p.cur != nil {
		return p.cur
	}
	g := &runtimeGen{done: make(chan struct{})}
	p.cur = g
	go func() {
		pool, err := initRuntime()
		p.mu.Lock()
		defer p.mu.Unlock()
		g.pool, g.err = pool, err
		close(g.done)
		switch {
		case err != nil:
			if p.cur == g {
				p.cur = nil // the next PDF tries again
			}
		case p.cur != g: // closed while compiling
			_ = pool.Close()
		case p.users == 0:
			p.armIdleLocked()
		}
	}()
	return g
}

// ready waits for a compiled runtime (ctx bounds the wait, not the compile); with use, it is
// taken (users) under the same lock, so it cannot be closed as idle before it is used.
func (p *PDFium) ready(ctx context.Context, use bool) (pdfium.Pool, error) {
	for {
		p.mu.Lock()
		g := p.startLocked()
		select {
		case <-g.done:
			if g.err != nil {
				p.mu.Unlock()
				return nil, g.err
			}
			if use {
				if p.idle != nil {
					p.idle.Stop()
				}
				p.users++
			}
			p.mu.Unlock()
			return g.pool, nil
		default:
		}
		p.mu.Unlock()
		select {
		case <-g.done: // look again: it may have failed or been closed meanwhile
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// Warm compiles the runtime if it is not compiled; ctx bounds only the wait (the compile goes
// on in the background).
func (p *PDFium) Warm(ctx context.Context) error {
	_, err := p.ready(ctx, false)
	return err
}

func (p *PDFium) acquire(ctx context.Context) (pdfium.Pool, error) {
	p.once.Do(func() { p.one = make(chan struct{}, 1) })
	// A cold start first, outside the document's slot and its deadline.
	if err := p.Warm(ctx); err != nil {
		return nil, err
	}
	wait, cancel := context.WithTimeout(ctx, p.timeout())
	defer cancel()
	select {
	case p.one <- struct{}{}:
	case <-wait.Done():
		return nil, errBusy
	}
	pool, err := p.ready(ctx, true)
	if err != nil {
		<-p.one
		return nil, err
	}
	return pool, nil
}

// armIdleLocked closes the runtime after Idle unused (p.mu held).
func (p *PDFium) armIdleLocked() {
	idle := p.Idle
	if idle <= 0 {
		idle = 5 * time.Minute
	}
	if p.idle != nil {
		p.idle.Stop()
	}
	p.idle = time.AfterFunc(idle, p.closeIdle)
}

func (p *PDFium) release() {
	p.mu.Lock()
	p.users--
	if p.users == 0 && p.cur != nil {
		p.armIdleLocked()
	}
	p.mu.Unlock()
	<-p.one
}

// closeLocked closes a compiled runtime (p.mu held); one still compiling is closed by its
// goroutine when it is done.
func (p *PDFium) closeLocked() {
	g := p.cur
	if g == nil {
		return
	}
	p.cur = nil
	select {
	case <-g.done:
		if g.pool != nil {
			_ = g.pool.Close()
		}
	default:
	}
}

func (p *PDFium) closeIdle() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.users == 0 {
		p.closeLocked()
	}
}

// Close closes the runtime (shutdown, tests).
func (p *PDFium) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.idle != nil {
		p.idle.Stop()
	}
	p.closeLocked()
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
