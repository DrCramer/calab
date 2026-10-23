package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/calaba/calaba/server/internal/ivrwire"
)

// The prompt cache: files are immutable per id (a new upload is a new file, ADR-0117 §6), so
// a downloaded prompt is kept on disk until the cache outgrows its budget (oldest use first).
const (
	cacheBudget = 200 << 20
	maxPrompt   = 10 << 20 // more than any prompt of ≤ 3 min at 32 kbit/s
)

var fileIDRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type cache struct {
	dir, apiURL, token string
	hc                 *http.Client
	mu                 sync.Mutex
}

func newCache(dir, apiURL, token string) *cache {
	return &cache{dir: dir, apiURL: apiURL, token: token, hc: &http.Client{Timeout: 30 * time.Second}}
}

// get returns the prompt's bytes, downloading it once.
func (c *cache) get(ctx context.Context, id string) ([]byte, error) {
	if !fileIDRe.MatchString(id) {
		return nil, fmt.Errorf("ivr: bad file id %q", id)
	}
	path := filepath.Join(c.dir, id+".ogg")
	if b, err := os.ReadFile(path); err == nil { //nolint:gosec // id is a validated uuid
		now := time.Now()
		_ = os.Chtimes(path, now, now)
		return b, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.apiURL+ivrwire.FilesPath+id, http.NoBody)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ivr: prompt %s: HTTP %d", id, resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxPrompt+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxPrompt {
		return nil, fmt.Errorf("ivr: prompt %s is too large", id)
	}
	c.store(path, b)
	return b, nil
}

func (c *cache) store(path string, b []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := os.MkdirAll(c.dir, 0o700); err != nil {
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return
	}
	c.trim()
}

// trim deletes the least recently used files beyond the budget.
func (c *cache) trim() {
	entries, err := os.ReadDir(c.dir)
	if err != nil {
		return
	}
	type f struct {
		path string
		size int64
		at   time.Time
	}
	var files []f
	var total int64
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || e.IsDir() {
			continue
		}
		files = append(files, f{filepath.Join(c.dir, e.Name()), info.Size(), info.ModTime()})
		total += info.Size()
	}
	sort.Slice(files, func(i, j int) bool { return files[i].at.Before(files[j].at) })
	for _, x := range files {
		if total <= cacheBudget {
			return
		}
		if os.Remove(x.path) == nil {
			total -= x.size
		}
	}
}
