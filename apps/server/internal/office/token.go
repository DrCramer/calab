package office

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// ---- the Document Server's JWT (api.onlyoffice.com «Signature») ----

// ConfigTokenTTL bounds the signed editor configuration. The configuration reaches the browser
// and the host page accepts it from any parent, so without an expiry a member who kept it could
// rejoin the session after losing access for as long as the session lives (days: forcesave keeps
// the key). Longer than a working day: the Document Server checks it on every (re)connect.
const ConfigTokenTTL = 12 * time.Hour

// requestTokenTTL bounds our requests to the Document Server (/command, /converter).
const requestTokenTTL = 5 * time.Minute

// signConfig signs the editor configuration or a request to the Document Server (/converter,
// /command): the token's claims are the object itself (HS256), which gets it as "token". exp is
// on the wall clock: the Document Server checks it with its own.
func signConfig(secret []byte, cfg map[string]any, ttl time.Duration) (string, error) {
	claims := jwt.MapClaims{}
	for k, v := range cfg {
		if k != "token" {
			claims[k] = v
		}
	}
	claims["exp"] = jwt.NewNumericDate(time.Now().Add(ttl))
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(secret)
}

// parseDS verifies a token signed with the Document Server's secret and returns its claims:
// HS256 only, exp required (the Document Server signs its outbox tokens with one, 5 min by
// default: a captured request is not replayable for long), a minute of clock skew.
func parseDS(secret []byte, tok string) (jwt.MapClaims, error) {
	claims := jwt.MapClaims{}
	_, err := jwt.ParseWithClaims(tok, claims, func(*jwt.Token) (any, error) { return secret, nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}), jwt.WithExpirationRequired(), jwt.WithLeeway(time.Minute))
	if err != nil {
		return nil, err
	}
	return claims, nil
}

// errOwnToken: a token of ours (the editor configuration every opener gets, a command, a
// conversion request) presented as a request of the Document Server. The secret is shared, so
// the claims tell them apart.
var errOwnToken = errors.New("office: not a document server request token")

// parseInbound verifies the token of a request the Document Server sends us (file download,
// callback): parseDS, then refuses the shapes we sign ourselves — above all the editor
// configuration, which every browser that opens a file holds.
func parseInbound(secret []byte, tok string) (jwt.MapClaims, error) {
	claims, err := parseDS(secret, tok)
	if err != nil {
		return nil, err
	}
	for _, c := range []jwt.MapClaims{claims, nested(claims)} {
		for _, k := range []string{"document", "editorConfig", "documentType", "c", "outputtype"} {
			if _, ok := c[k]; ok {
				return nil, errOwnToken
			}
		}
	}
	return claims, nil
}

// nested is claims.payload (the header token of the Document Server: the body under
// "payload"), or nil.
func nested(claims jwt.MapClaims) jwt.MapClaims {
	if p, ok := claims["payload"].(map[string]any); ok {
		return p
	}
	return nil
}

// bearer is the token of an "Authorization: Bearer …" header ("" without one).
func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

// errOperation: a Document Server token for another request (10.0+ «operation»).
var errOperation = errors.New("office: token operation mismatch")

// checkOperation accepts a token without "operation" (Document Server before 10.0) or with op.
func checkOperation(claims jwt.MapClaims, op string) error {
	if v, ok := claims["operation"]; ok && v != op {
		return errOperation
	}
	return nil
}

// ---- our URL tokens (file and callback URLs) ----

const (
	opFile     = "file"     // a Disk item's file: subject = the item, fid = the pinned version
	opAttach   = "afile"    // an attachment: subject = the file itself
	opCallback = "callback" // a session's callback: subject = the item, k = the session key
)

type urlClaims struct {
	Op   string `json:"op"`
	File string `json:"fid,omitempty"`
	Key  string `json:"k,omitempty"`
	jwt.RegisteredClaims
}

// signURL issues the token of a file URL (exp set, pinned to fileID) or a callback URL (no exp:
// a session may stay open for days; the Document Server's own JWT authenticates the callback;
// pinned to the session key, so one session's URL never carries another session's saves).
func signURL(key []byte, op string, subject, fileID uuid.UUID, sessKey string, exp time.Time) (string, error) {
	c := urlClaims{Op: op, Key: sessKey, RegisteredClaims: jwt.RegisteredClaims{Subject: subject.String(), Audience: jwt.ClaimStrings{"office"}}}
	if fileID != uuid.Nil {
		c.File = fileID.String()
	}
	if !exp.IsZero() {
		c.ExpiresAt = jwt.NewNumericDate(exp)
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(key)
}

// urlToken is a verified URL token.
type urlToken struct {
	Subject, FileID uuid.UUID
	Key             string
}

// parseURL verifies a URL token of operation op at now.
func parseURL(key []byte, op, tok string, now time.Time) (urlToken, error) {
	var c urlClaims
	var t urlToken
	_, err := jwt.ParseWithClaims(tok, &c, func(*jwt.Token) (any, error) { return key, nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}), jwt.WithAudience("office"),
		jwt.WithTimeFunc(func() time.Time { return now }))
	if err != nil {
		return t, err
	}
	if c.Op != op {
		return t, fmt.Errorf("office: url token for %q", c.Op)
	}
	if (op == opFile || op == opAttach) && c.ExpiresAt == nil {
		return t, errors.New("office: file url token without exp")
	}
	if op == opCallback && c.Key == "" {
		return t, errors.New("office: callback url token without a session key")
	}
	if t.Subject, err = uuid.Parse(c.Subject); err != nil {
		return t, err
	}
	if c.File != "" {
		if t.FileID, err = uuid.Parse(c.File); err != nil {
			return t, err
		}
	}
	t.Key = c.Key
	return t, nil
}

// DeriveURLKey derives the URL token key from the API's JWT_SECRET (a separate key: a leaked
// URL token never verifies as a session token and back).
func DeriveURLKey(apiSecret []byte) []byte {
	m := hmac.New(sha256.New, apiSecret)
	m.Write([]byte("calab-office-url-v1"))
	return m.Sum(nil)
}

// sessionKey is the document.key of a session that starts on fileID: deterministic, so two
// members opening the item at once get the same key even before Join settles; 0-9a-f and «-»
// only, 46 characters (the Document Server allows [0-9a-zA-Z.=_-], up to 128). Keyed with the
// URL key: keys are unique per installation on a shared Document Server.
func sessionKey(urlKey []byte, item, fileID uuid.UUID) string {
	m := hmac.New(sha256.New, urlKey)
	m.Write(item[:])
	m.Write(fileID[:])
	return "calab-" + hex.EncodeToString(m.Sum(nil)[:20])
}

// viewKey is the document.key of an attachment (prefix "a-": immutable, one key per file) or
// of a conversion (prefix "c-": per file and target).
func viewKey(urlKey []byte, prefix string, fileID uuid.UUID, extra string) string {
	m := hmac.New(sha256.New, urlKey)
	m.Write([]byte(prefix))
	m.Write(fileID[:])
	m.Write([]byte(extra))
	return "calab-" + prefix + hex.EncodeToString(m.Sum(nil)[:20])
}
