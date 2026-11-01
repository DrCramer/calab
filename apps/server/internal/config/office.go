package config

import (
	"errors"
	"time"
)

// Office is the editing of office files in ONLYOFFICE Docs (ADR-0143): off by default;
// the Document Server runs as its own container, its host and secret come only from here.
type Office struct {
	Enabled bool `env:"OFFICE_ENABLED"`
	// DocsURL: the Document Server origin for the browser (the editor's api.js, its frame).
	DocsURL string `env:"OFFICE_DOCS_URL"`
	// DocsInternalURL: how the API reaches the Document Server (saved files). Empty = DocsURL.
	DocsInternalURL string `env:"OFFICE_DOCS_INTERNAL_URL"`
	// APIURL: how the Document Server reaches the API (file and callback URLs; in k8s the
	// in-cluster service). Empty = PUBLIC_APP_URL.
	APIURL string `env:"OFFICE_API_URL"`
	// JWTSecret: the Document Server's JWT_SECRET (HS256, both ways).
	JWTSecret string `env:"OFFICE_JWT_SECRET"`
	// ThemeDark / ThemeLight: the editor's uiTheme per app theme (a custom theme JSON on the
	// Document Server, or the built-in default-dark / default-light).
	ThemeDark  string        `env:"OFFICE_THEME_DARK" envDefault:"default-dark"`
	ThemeLight string        `env:"OFFICE_THEME_LIGHT" envDefault:"default-light"`
	FileURLTTL time.Duration `env:"OFFICE_FILE_URL_TTL" envDefault:"5m"`
	MaxSizeMB  int64         `env:"OFFICE_MAX_SIZE_MB" envDefault:"100"`
	// SessionTTL: a co-editing session in Valkey without an open or a callback for this long is
	// forgotten (the Document Server ends idle ones itself).
	SessionTTL time.Duration `env:"OFFICE_SESSION_TTL" envDefault:"24h"`
}

// validate checks the office settings; apiSecret is JWT_SECRET, which OFFICE_JWT_SECRET must not
// reuse: the Document Server (and every browser's signed editor configuration) holds the
// office secret, and the API's own tokens must not verify with it.
func (o *Office) validate(apiSecret string) error {
	if !o.Enabled {
		return nil
	}
	var errs []error
	if o.JWTSecret != "" && o.JWTSecret == apiSecret {
		errs = append(errs, errors.New("OFFICE_JWT_SECRET must differ from JWT_SECRET"))
	}
	if Origin(o.DocsURL) == "" {
		errs = append(errs, errors.New("OFFICE_DOCS_URL must be an http(s) origin when OFFICE_ENABLED"))
	}
	if o.DocsInternalURL != "" && Origin(o.DocsInternalURL) == "" {
		errs = append(errs, errors.New("OFFICE_DOCS_INTERNAL_URL must be an http(s) origin"))
	}
	if o.APIURL != "" && Origin(o.APIURL) == "" {
		errs = append(errs, errors.New("OFFICE_API_URL must be an http(s) origin"))
	}
	if len(o.JWTSecret) < 32 {
		errs = append(errs, errors.New("OFFICE_JWT_SECRET must be at least 32 bytes when OFFICE_ENABLED"))
	}
	if o.FileURLTTL < 30*time.Second || o.FileURLTTL > time.Hour {
		errs = append(errs, errors.New("OFFICE_FILE_URL_TTL must be between 30s and 1h"))
	}
	if o.SessionTTL < time.Hour || o.SessionTTL > 7*24*time.Hour {
		errs = append(errs, errors.New("OFFICE_SESSION_TTL must be between 1h and 168h"))
	}
	if o.MaxSizeMB < 1 {
		errs = append(errs, errors.New("OFFICE_MAX_SIZE_MB must be >= 1"))
	}
	return errors.Join(errs...)
}
