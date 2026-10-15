package oauthprovider

import (
	"encoding/base64"
	"net"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

func scopeSet(raw string) ([]string, bool) {
	scopes := strings.Fields(raw)
	if len(scopes) == 0 || len(scopes) > 3 || !slices.Contains(scopes, "openid") {
		return nil, false
	}
	seen := map[string]bool{}
	for _, scope := range scopes {
		if !slices.Contains([]string{"openid", "profile", "email"}, scope) || seen[scope] {
			return nil, false
		}
		seen[scope] = true
	}
	slices.Sort(scopes)
	return scopes, true
}

func validChallenge(raw string) bool {
	b, err := base64.RawURLEncoding.Strict().DecodeString(raw)
	return len(raw) == 43 && err == nil && len(b) == 32
}
func validVerifier(raw string) bool {
	if len(raw) < 43 || len(raw) > 128 {
		return false
	}
	for _, r := range raw {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-._~", r) {
			continue
		}
		return false
	}
	return true
}

// parseRedirect accepts an exact https URI for every client type, and a plain-http
// loopback URI (localhost, 127.0.0.1, [::1]) for every type too (ADR-0102): loopback
// traffic never leaves the machine, and providers accept it for development. Only
// native clients may register a reverse-domain private scheme (RFC 8252 §7.1).
func parseRedirect(raw, kind string) (*url.URL, bool) {
	u, problem := redirectProblem(raw, kind)
	return u, problem == ""
}

// Redirect URI problems, reported as stable validation messages (field redirectUris);
// the desktop form keys its texts on them (lib/api/errors.ts).
const (
	redirectInvalid = "redirect URI is not a valid absolute URL"
	redirectChars   = "redirect URI must not contain spaces, # or *"
	redirectScheme  = "redirect URI must use https (http only for localhost, 127.0.0.1 or [::1])"
	redirectNative  = "custom scheme redirect URIs are only for native clients"
)

func redirectProblem(raw, kind string) (*url.URL, string) {
	if len(raw) == 0 || len(raw) > 2048 {
		return nil, redirectInvalid
	}
	if strings.ContainsAny(raw, "\r\n\t ") || strings.Contains(raw, "#") || strings.Contains(raw, "*") {
		return nil, redirectChars
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Opaque != "" || u.Scheme == "" {
		return nil, redirectInvalid
	}
	if u.Scheme == "https" {
		if u.Host == "" {
			return nil, redirectInvalid
		}
		return u, ""
	}
	if u.Scheme == "http" {
		if loopback(u) {
			return u, ""
		}
		return nil, redirectScheme
	}
	// Reverse-domain private schemes require administrative registration and PKCE.
	if strings.Contains(u.Scheme, ".") && u.Path != "" {
		if kind != "public_native" {
			return nil, redirectNative
		}
		return u, ""
	}
	return nil, redirectScheme
}

// loopback reports a plain loopback host: the literal 127.0.0.1 or ::1, or localhost.
func loopback(u *url.URL) bool {
	return u.Hostname() == "localhost" || loopbackIP(u)
}
func loopbackIP(u *url.URL) bool {
	if u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" {
		return false
	}
	if net.ParseIP(u.Hostname()) == nil {
		return false
	}
	if u.Port() != "" {
		p, err := strconv.Atoi(u.Port())
		if err != nil || p < 1 || p > 65535 {
			return false
		}
	}
	return true
}

// redirectMatches compares exactly. Only a native client may vary the port of a
// registered loopback IP literal (RFC 8252 §7.3); web and SPA loopback URIs, and
// localhost for every type, must match byte for byte.
func redirectMatches(raw, registered, kind string) bool {
	u, ok := parseRedirect(raw, kind)
	if !ok {
		return false
	}
	r, ok := parseRedirect(registered, kind)
	if !ok {
		return false
	}
	if raw == registered {
		return true
	}
	if kind != "public_native" || u.Scheme != "http" || r.Scheme != "http" || !loopbackIP(u) || !loopbackIP(r) || u.Hostname() != r.Hostname() {
		return false
	}
	// Strip only the literal loopback port; every other byte remains exact.
	u.Host = r.Host
	return u.String() == registered
}
func validOrigin(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.Path == "" && u.RawQuery == "" && !u.ForceQuery && !strings.ContainsAny(raw, "#*\r\n\t ")
}
