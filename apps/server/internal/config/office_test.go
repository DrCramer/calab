package config

import (
	"strings"
	"testing"
)

func TestOfficeOffByDefault(t *testing.T) {
	billingEnv(t)
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Office.Enabled || c.Office.DocsURL != "" || c.Office.ThemeDark != "default-dark" {
		t.Fatalf("office defaults: %+v", c.Office)
	}
}

func TestOfficeValidation(t *testing.T) {
	billingEnv(t)
	t.Setenv("OFFICE_ENABLED", "true")
	t.Setenv("OFFICE_DOCS_URL", "https://docs.calab.test")
	t.Setenv("OFFICE_JWT_SECRET", strings.Repeat("s", 32))
	if _, err := Load(); err != nil {
		t.Fatalf("valid office configuration: %v", err)
	}
	for _, c := range []struct{ key, value, want string }{
		{"OFFICE_DOCS_URL", "", "OFFICE_DOCS_URL"},
		{"OFFICE_DOCS_URL", "docs.calab.test", "OFFICE_DOCS_URL"},
		{"OFFICE_JWT_SECRET", "short", "OFFICE_JWT_SECRET"},
		{"OFFICE_API_URL", "api", "OFFICE_API_URL"},
		{"OFFICE_FILE_URL_TTL", "24h", "OFFICE_FILE_URL_TTL"},
		{"OFFICE_JWT_SECRET", "0123456789abcdef0123456789abcdef", "must differ from JWT_SECRET"}, // = JWT_SECRET of billingEnv
	} {
		t.Run(c.key+"="+c.value, func(t *testing.T) {
			t.Setenv(c.key, c.value)
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("got %v, want %q", err, c.want)
			}
			if c.key == "OFFICE_JWT_SECRET" && strings.Contains(err.Error(), c.value) {
				t.Fatal("error text leaks the secret")
			}
		})
	}
}
