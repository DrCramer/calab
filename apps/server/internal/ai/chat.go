// Package ai is the AI integration of a workspace (CBF-60, ai.proto): the provider settings
// (GPTunneL or any OpenAI-compatible API, the key sealed at rest) and the «Проверить» check,
// one Chat Completions call with the message «hi».
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/calaba/calaba/server/internal/unfurl"
)

// Check outcomes (CheckAiResponse.error).
const (
	ErrUnauthorized        = "unauthorized"
	ErrModelNotFound       = "model_not_found"
	ErrNotFound            = "not_found"
	ErrInsufficientBalance = "insufficient_balance"
	ErrRateLimited         = "rate_limited"
	ErrProvider            = "provider_error"
	ErrBadRequest          = "bad_request"
	ErrBadResponse         = "bad_response"
	ErrTimeout             = "timeout"
	ErrNetwork             = "network"
	ErrBlockedAddress      = "blocked_address"
)

// CheckTimeout bounds one check call (the client waits up to ~30 s).
const CheckTimeout = 30 * time.Second

// VisionTimeout bounds a call whose messages carry images (CBF-75): uploading and reading them
// takes the provider longer.
const VisionTimeout = 45 * time.Second

const (
	maxAnswer = 1 << 20 // bytes of a provider answer read
	maxReply  = 200     // characters of the model's reply returned by the check
	// MaxCompletion bounds the text of an answer Send returns (characters).
	MaxCompletion = 32000
	maxMessage    = 300 // characters of the provider's error text returned
)

// Result is the outcome of one check call.
type Result struct {
	OK      bool
	Reply   string
	Error   string // one of the Err* codes; empty when OK
	Message string
	Status  int // the provider's HTTP status, 0 = none
	Latency time.Duration
}

// Chat calls OpenAI-compatible Chat Completions APIs.
type Chat struct{ HTTP *http.Client }

// NewChat builds a client whose transport dials only addresses allow accepts (nil = any: the
// server's own configured provider). Redirects are not followed: the key goes to the URL given.
func NewChat(allow func(netip.Addr) bool) *Chat {
	tr := http.DefaultTransport
	if allow != nil {
		tr = unfurl.SafeTransport(CheckTimeout, allow)
	}
	return &Chat{HTTP: &http.Client{
		Transport:     tr,
		Timeout:       VisionTimeout, // each call bounds itself (Send)
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
	// Parts, when set, are sent as the content instead of Content (a vision message of
	// Chat Completions: text and image_url parts, CBF-75).
	Parts []Part `json:"-"`
}

// MarshalJSON sends Parts as the content array when there are any, Content otherwise.
func (m chatMessage) MarshalJSON() ([]byte, error) {
	if len(m.Parts) == 0 {
		type plain chatMessage
		return json.Marshal(plain(m))
	}
	return json.Marshal(struct {
		Role    string `json:"role"`
		Content []Part `json:"content"`
	}{m.Role, m.Parts})
}

// Part is one part of a message's content: {"type":"text","text"} or
// {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,…"}}.
type Part struct {
	Type     string    `json:"type"`
	Text     string    `json:"text,omitempty"`
	ImageURL *ImageURL `json:"image_url,omitempty"`
}

// ImageURL is the image of a Part (a data: URL; never a link the provider would fetch).
type ImageURL struct {
	URL string `json:"url"`
}

// TextPart / ImagePart build parts.
func TextPart(s string) Part { return Part{Type: "text", Text: s} }

// ImagePart is a JPEG given as a data: URL.
func ImagePart(dataURL string) Part {
	return Part{Type: "image_url", ImageURL: &ImageURL{URL: dataURL}}
}

type chatRequest struct {
	Model    string        `json:"model"`
	Messages []chatMessage `json:"messages"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content any `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *providerError `json:"error"`
}

// providerError is the OpenAI error object ({"error": {"message", "type", "code"}}); some
// providers answer a bare string instead.
type providerError struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Code    any    `json:"code"`
}

func (p *providerError) UnmarshalJSON(b []byte) error {
	var s string
	if json.Unmarshal(b, &s) == nil {
		p.Message = s
		return nil
	}
	type plain providerError
	return json.Unmarshal(b, (*plain)(p))
}

// Hello sends one user message «hi» to model at baseURL (…/chat/completions is appended) with
// the Bearer key and reports whether an answer came. It never returns the key in any field.
func (c *Chat) Hello(ctx context.Context, baseURL, key, model string) Result {
	out := c.Send(ctx, baseURL, key, model, []Message{{Role: "user", Content: "hi"}})
	out.Reply = clip(out.Reply, maxReply)
	return out
}

// Message is one Chat Completions message (role system | user | assistant).
type Message = chatMessage

// Send sends messages to model at baseURL with the Bearer key (one call, ≤ CheckTimeout, ≤
// VisionTimeout with images) and returns the answer's text in Reply (≤ MaxCompletion
// characters, the key scrubbed).
func (c *Chat) Send(ctx context.Context, baseURL, key, model string, msgs []Message) Result {
	timeout := CheckTimeout
	for _, m := range msgs {
		if len(m.Parts) > 0 {
			timeout = VisionTimeout
		}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	body, _ := json.Marshal(chatRequest{Model: model, Messages: msgs})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/chat/completions", bytes.NewReader(body)) //nolint:gosec // G704: a user URL goes through the SSRF-safe dialer (NewChat)
	if err != nil {
		return Result{Error: ErrBadRequest, Message: "invalid base URL"}
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	start := time.Now()
	resp, err := c.HTTP.Do(req) //nolint:gosec // G704: see above
	if err != nil {
		return Result{Error: transportError(ctx, err), Message: clip(scrub(rootCause(err), key), maxMessage), Latency: time.Since(start)}
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxAnswer))
	out := Result{Status: resp.StatusCode, Latency: time.Since(start)}
	if err != nil {
		out.Error, out.Message = transportError(ctx, err), clip(scrub(rootCause(err), key), maxMessage)
		return out
	}
	var cr chatResponse
	jsonErr := json.Unmarshal(raw, &cr)
	if resp.StatusCode/100 != 2 {
		msg := ""
		code := ""
		if jsonErr == nil && cr.Error != nil {
			msg = cr.Error.Message
			if s, ok := cr.Error.Code.(string); ok {
				code = s
			}
			if code == "" {
				code = cr.Error.Type
			}
		} else if utf8.Valid(raw) && !bytes.HasPrefix(bytes.TrimSpace(raw), []byte("<")) {
			msg = string(raw) // a plain-text answer; HTML error pages say nothing useful
		}
		if msg == "" {
			msg = http.StatusText(resp.StatusCode)
		}
		out.Error, out.Message = classify(resp.StatusCode, code, msg), clip(scrub(strings.TrimSpace(msg), key), maxMessage)
		return out
	}
	if jsonErr != nil || len(cr.Choices) == 0 {
		if jsonErr == nil && cr.Error != nil && cr.Error.Message != "" {
			out.Error, out.Message = ErrProvider, clip(scrub(cr.Error.Message, key), maxMessage)
			return out
		}
		out.Error, out.Message = ErrBadResponse, "the answer is not a Chat Completions response"
		return out
	}
	out.OK = true
	out.Reply = clip(scrub(strings.TrimSpace(contentText(cr.Choices[0].Message.Content)), key), MaxCompletion)
	return out
}

// contentText is message.content as text: a string, or the parts of an array ([{type, text}]).
func contentText(c any) string {
	switch v := c.(type) {
	case string:
		return v
	case []any:
		var b strings.Builder
		for _, p := range v {
			if m, ok := p.(map[string]any); ok {
				if s, ok := m["text"].(string); ok {
					b.WriteString(s)
				}
			}
		}
		return b.String()
	}
	return ""
}

// classify maps a provider's HTTP error to a check outcome.
func classify(status int, code, msg string) string {
	lc, lm := strings.ToLower(code), strings.ToLower(msg)
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return ErrUnauthorized
	case status == http.StatusPaymentRequired || strings.Contains(lc, "insufficient") || strings.Contains(lm, "insufficient") || strings.Contains(lm, "balance"):
		return ErrInsufficientBalance
	case status == http.StatusTooManyRequests:
		return ErrRateLimited
	case lc == "model_not_found" || (status == http.StatusNotFound || status == http.StatusBadRequest) && strings.Contains(lm, "model"):
		return ErrModelNotFound
	case status == http.StatusNotFound:
		return ErrNotFound
	case status >= 500:
		return ErrProvider
	default:
		return ErrBadRequest
	}
}

func transportError(ctx context.Context, err error) string {
	var ne net.Error
	switch {
	case errors.Is(err, unfurl.ErrBlocked):
		return ErrBlockedAddress
	case errors.Is(ctx.Err(), context.DeadlineExceeded), errors.Is(err, context.DeadlineExceeded), errors.As(err, &ne) && ne.Timeout():
		return ErrTimeout
	default:
		return ErrNetwork
	}
}

// rootCause is the innermost error text (without the URL wrapper of net/http).
func rootCause(err error) string {
	for {
		u := errors.Unwrap(err)
		if u == nil {
			return err.Error()
		}
		err = u
	}
}

// scrub removes the key from a text a provider might echo it in.
func scrub(s, key string) string {
	if key == "" {
		return s
	}
	return strings.ReplaceAll(s, key, "***")
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}
