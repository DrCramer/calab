package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/livekit/server-sdk-go/v2/pkg/oggreader"
	"github.com/pion/webrtc/v4/pkg/media"
)

// clip is an Opus stream as packets with their durations (decoded once from Ogg).
type clip struct {
	packets [][]byte
	durs    []time.Duration
}

// maxClip bounds a decoded clip (prompts are ≤ 3 min, ADR-0117 §6: 9000 packets of 20 ms).
const maxClip = 20000

var errEmptyClip = errors.New("ivr: no audio packets in the file")

// decodeOgg splits an Ogg/Opus file into its packets (the ID and comment headers skipped).
func decodeOgg(b []byte) (*clip, error) {
	r, _, err := oggreader.NewOggReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	c := &clip{}
	for len(c.packets) < maxClip {
		p, err := r.ReadPacket()
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		if len(p) == 0 || bytes.HasPrefix(p, []byte("OpusTags")) {
			continue
		}
		d, err := oggreader.ParsePacketDuration(p)
		if err != nil || d <= 0 {
			continue
		}
		c.packets = append(c.packets, p)
		c.durs = append(c.durs, d)
	}
	if len(c.packets) == 0 {
		return nil, errEmptyClip
	}
	return c, nil
}

// silence is one 20 ms Opus frame of silence (TOC 0xF8: CELT fullband 20 ms, mono, one frame).
var silence = []byte{0xF8, 0xFF, 0xFE}

const silenceDur = 20 * time.Millisecond

// player is the call's one audio source (an lksdk SampleProvider): the current clip, once or
// in a loop, else silence. One published track for the whole call, so switching a prompt or
// stopping never republishes (no click, no renegotiation — ADR-0117 «Проверить» 4).
type player struct {
	mu     sync.Mutex
	cur    *clip
	pos    int
	loop   bool
	onDone func() // a non-looping clip played to its end
}

func (p *player) play(c *clip, loop bool, onDone func()) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cur, p.pos, p.loop, p.onDone = c, 0, loop, onDone
}

func (p *player) stop() {
	p.play(nil, false, nil)
}

// NextSample implements lksdk.SampleProvider (the track paces the samples by Duration).
func (p *player) NextSample(ctx context.Context) (media.Sample, error) {
	if err := ctx.Err(); err != nil {
		return media.Sample{}, io.EOF
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cur == nil {
		return media.Sample{Data: silence, Duration: silenceDur}, nil
	}
	s := media.Sample{Data: p.cur.packets[p.pos], Duration: p.cur.durs[p.pos]}
	p.pos++
	if p.pos >= len(p.cur.packets) {
		if p.loop {
			p.pos = 0
		} else {
			done := p.onDone
			p.cur, p.onDone = nil, nil
			if done != nil {
				go done()
			}
		}
	}
	return s, nil
}

// OnBind implements lksdk.SampleProvider.
func (p *player) OnBind() error { return nil }

// OnUnbind implements lksdk.SampleProvider.
func (p *player) OnUnbind() error { return nil }

// Close implements lksdk.SampleProvider.
func (p *player) Close() error { return nil }
