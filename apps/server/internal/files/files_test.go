package files

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"net/url"
	"strings"
	"testing"
)

func TestLimitHash(t *testing.T) {
	data := strings.Repeat("abc", 1000)
	l := &limitHash{r: strings.NewReader(data), h: sha256.New(), limit: int64(len(data))}
	if _, err := io.Copy(io.Discard, l); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(data))
	if l.n != int64(len(data)) || hex.EncodeToString(l.h.Sum(nil)) != hex.EncodeToString(sum[:]) {
		t.Fatal("count or hash mismatch")
	}
	l = &limitHash{r: strings.NewReader(data), h: sha256.New(), limit: int64(len(data)) - 1}
	if _, err := io.Copy(io.Discard, l); !errors.Is(err, errTooLarge) {
		t.Fatalf("over limit: %v", err)
	}
}

func TestDetectMime(t *testing.T) {
	png := "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
	for _, c := range []struct{ head, declared, want string }{
		{png, "text/plain", "image/png"},                         // sniffing wins
		{"hello world", "text/csv", "text/csv"},                  // inconclusive sniff: declared kept
		{"hello world", "image/png", "text/plain"},               // cannot claim an image
		{"hello world", "text/html", "text/plain"},               // no active content
		{"<svg xmlns='x'></svg>", "image/svg+xml", "text/plain"}, // svg is never an image
		{"\x00\x01\x02", "application/zip", "application/zip"},
		{"\x00\x01\x02", "", "application/octet-stream"},
		{png, "application/octet-stream", "image/png"}, // a wrong declared type never wins over the content
		{png, "", "image/png"},
		{"\x00\x00\x00\x1cftypavif\x00\x00\x00\x00avifmif1miaf", "", "image/avif"}, // net/http does not sniff AVIF
		{"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic", "image/avif", "application/octet-stream"},
	} {
		if got := DetectMime([]byte(c.head), c.declared); got != c.want {
			t.Errorf("%q/%q: got %q want %q", c.head, c.declared, got, c.want)
		}
	}
}

func TestSanitizeName(t *testing.T) {
	for in, want := range map[string]string{
		"a.txt": "a.txt", "../../etc/passwd": "passwd", `C:\\Users\\x\\doc.pdf`: "doc.pdf",
		"": "file", "bad\x00name\n.txt": "badname.txt", " spaced ": "spaced",
	} {
		if got := SanitizeName(in); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
	if n := SanitizeName(strings.Repeat("я", 300)); len(n) > 255 || !strings.HasPrefix(n, "я") {
		t.Errorf("long name: %d bytes", len(n))
	}
}

func TestIsOggOpus(t *testing.T) {
	page := func(segs int, packet string) []byte {
		b := append([]byte("OggS"), make([]byte, 22)...)
		b = append(b, byte(segs)) //nolint:gosec // test pages have < 256 segments
		b = append(b, make([]byte, segs)...)
		return append(b, packet...)
	}
	for _, c := range []struct {
		name string
		head []byte
		want bool
	}{
		{"opus", page(1, "OpusHead\x01\x01"), true},
		{"opus, 3 segments", page(3, "OpusHead"), true},
		{"vorbis", page(1, "\x01vorbis"), false},
		{"webm", []byte("\x1a\x45\xdf\xa3" + strings.Repeat("\x00", 40)), false},
		{"short", []byte("OggS"), false},
		{"truncated", page(1, "Opus"), false},
	} {
		if got := IsOggOpus(c.head); got != c.want {
			t.Errorf("%s: IsOggOpus = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestParseVoice(t *testing.T) {
	q := func(kv ...string) url.Values {
		v := url.Values{}
		for i := 0; i+1 < len(kv); i += 2 {
			v.Set(kv[i], kv[i+1])
		}
		return v
	}
	if v, err := parseVoice(q()); v != nil || err != nil {
		t.Fatalf("no params: %v %v", v, err)
	}
	v, err := parseVoice(q("voice_duration_ms", "61000", "voice_waveform", "AAr_"))
	if err != nil || v.durationMs != 61000 || len(v.waveform) != 3 || v.waveform[2] != 0xff {
		t.Fatalf("valid: %+v %v", v, err)
	}
	if v, err := parseVoice(q("voice_duration_ms", "5000")); err != nil || len(v.waveform) != 0 {
		t.Fatalf("no waveform: %+v %v", v, err)
	}
	for _, bad := range []url.Values{
		q("voice_duration_ms", "0"),
		q("voice_duration_ms", "300001"),
		q("voice_duration_ms", "x"),
		q("voice_waveform", "AA"),
		q("voice_duration_ms", "1000", "voice_waveform", "***"),
		q("voice_duration_ms", "1000", "voice_waveform", base64.RawURLEncoding.EncodeToString(make([]byte, MaxVoiceBars+1))),
	} {
		if _, err := parseVoice(bad); err == nil {
			t.Errorf("%v: want an error", bad)
		}
	}
}
