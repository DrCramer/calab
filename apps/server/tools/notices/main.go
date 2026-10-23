// Command notices writes THIRD-PARTY-NOTICES.txt: the license texts of every Go module
// linked into the server binary (go list -deps ./cmd/server) for the Dockerfile's target,
// linux/amd64 with CGO_ENABLED=0 and -tags nodynamic, whatever the host OS: the dependency
// set differs per platform (e.g. prometheus/procfs is linux-only).
// It fails on copyleft (GPL / LGPL / AGPL), source-available terms (SSPL, RSAL, BUSL),
// unknown licenses and modules without a license file, so a new dependency with such
// terms cannot slip in unnoticed.
//
//	go run ./tools/notices > THIRD-PARTY-NOTICES.txt   (make third-party-notices)
package main

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
)

type module struct {
	Path, Version, Dir string
	Replace            *module
}

type pkg struct {
	Standard bool
	Module   *module
}

// License and NOTICE files (Apache-2.0 requires reproducing NOTICE), e.g. LICENSE,
// LICENSE.md, NOTICE, lib/LICENSE.libwebp (C code transpiled into Go by the module).
var licenseFile = regexp.MustCompile(`(?i)^(licen[cs]e|copying|notice)(\.(md|txt|rst)|[._-][a-z0-9]+)?$`)

// classify maps a license text to an SPDX id by its characteristic wording.
func classify(text string) string {
	t := strings.Join(strings.Fields(text), " ")
	switch {
	case strings.Contains(t, "Server Side Public License"):
		return "SSPL"
	case strings.Contains(t, "Redis Source Available License"):
		return "RSAL"
	case strings.Contains(t, "Business Source License"):
		return "BUSL"
	case strings.Contains(t, "GNU AFFERO GENERAL PUBLIC LICENSE"):
		return "AGPL"
	case strings.Contains(t, "GNU LESSER GENERAL PUBLIC LICENSE"):
		return "LGPL"
	case strings.Contains(t, "GNU GENERAL PUBLIC LICENSE"):
		return "GPL"
	case strings.Contains(t, "Apache License") && strings.Contains(t, "Version 2.0"):
		return "Apache-2.0"
	case strings.Contains(t, "Mozilla Public License"):
		return "MPL-2.0"
	case strings.Contains(t, "Permission is hereby granted, free of charge"):
		return "MIT"
	case strings.Contains(t, "Permission to use, copy, modify, and/or distribute"),
		strings.Contains(t, "Permission to use, copy, modify, and distribute this software for any purpose with or without fee"):
		return "ISC"
	case strings.Contains(t, "Redistribution and use in source and binary forms"):
		if strings.Contains(t, "Neither the name") || strings.Contains(t, "names of its contributors") {
			return "BSD-3-Clause"
		}
		return "BSD-2-Clause"
	}
	return "UNKNOWN"
}

// target is the platform of the image (Dockerfile: CGO_ENABLED=0 go build on linux/amd64).
var target = []string{"GOOS=linux", "GOARCH=amd64", "CGO_ENABLED=0"}

// moduleRoot is the server module directory (where go.mod is), so the tool works from any
// working directory inside the module (make target, go test).
func moduleRoot() (string, error) {
	out, err := exec.CommandContext(context.Background(), "go", "env", "GOMOD").Output()
	if err != nil {
		return "", err
	}
	gomod := strings.TrimSpace(string(out))
	if gomod == "" || gomod == os.DevNull {
		return "", errors.New("not inside a Go module")
	}
	return filepath.Dir(gomod), nil
}

// embedded are the notices of native code a module embeds that its own license files do not
// cover (go-pdfium's pdfium.wasm: PDFium and the C/C++ libraries compiled into it). The file is
// appended after the module's license texts.
var embedded = map[string]string{
	"github.com/klippa-app/go-pdfium": "embedded/go-pdfium.txt",
}

//go:embed embedded/*.txt
var embeddedFS embed.FS

var forbidden = map[string]bool{"GPL": true, "LGPL": true, "AGPL": true, "SSPL": true, "RSAL": true, "BUSL": true, "UNKNOWN": true}

func modules() ([]module, error) {
	root, err := moduleRoot()
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(context.Background(), "go", "list", "-deps", "-tags", "nodynamic", "-json=Standard,Module", "./cmd/server")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), target...)
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	seen := map[string]module{}
	dec := json.NewDecoder(bytes.NewReader(out))
	for {
		var p pkg
		if err := dec.Decode(&p); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return nil, err
		}
		if p.Standard || p.Module == nil || p.Module.Version == "" { // stdlib, main module
			continue
		}
		m := *p.Module
		if m.Replace != nil {
			m.Dir = m.Replace.Dir
		}
		seen[m.Path] = m
	}
	list := make([]module, 0, len(seen))
	for _, m := range seen {
		list = append(list, m)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Path < list[j].Path })
	return list, nil
}

// licenseText collects license / NOTICE files from the module root and its direct
// subdirectories (bundled third-party code keeps its license there).
func licenseText(dir string) (license, all string, err error) {
	var lic, parts []string
	var walk func(d, rel string, depth int) error
	walk = func(d, rel string, depth int) error {
		entries, err := os.ReadDir(d)
		if err != nil {
			return err
		}
		for _, e := range entries {
			name := e.Name()
			if e.IsDir() {
				if depth == 0 && name != "testdata" && name != "vendor" && !strings.HasPrefix(name, ".") {
					if err := walk(filepath.Join(d, name), name+"/", 1); err != nil {
						return err
					}
				}
				continue
			}
			if !licenseFile.MatchString(name) {
				continue
			}
			b, err := os.ReadFile(filepath.Join(d, name)) //nolint:gosec // module cache path
			if err != nil {
				return err
			}
			text := strings.TrimSpace(string(b))
			if !strings.HasPrefix(strings.ToLower(name), "notice") {
				lic = append(lic, text)
			}
			parts = append(parts, "--- "+rel+name+" ---\n"+text)
		}
		return nil
	}
	if err := walk(dir, "", 0); err != nil {
		return "", "", err
	}
	return strings.Join(lic, "\n\n"), strings.Join(parts, "\n\n"), nil
}

func run() error { return generate(os.Stdout) }

// generate writes the notices to w; it fails after writing if a license needs review.
func generate(w io.Writer) error {
	mods, err := modules()
	if err != nil {
		return err
	}
	var out, body, table strings.Builder
	var problems []string
	for p := range embedded { // a stale entry: the module left the binary
		if !slices.ContainsFunc(mods, func(m module) bool { return m.Path == p }) {
			problems = append(problems, p+": in embedded but not linked into the server")
		}
	}
	summary := map[string][]string{}
	for _, m := range mods {
		lic, text, err := licenseText(m.Dir)
		if err != nil {
			return fmt.Errorf("%s: %w", m.Path, err)
		}
		id := "UNKNOWN"
		if lic != "" {
			id = classify(lic)
		}
		summary[id] = append(summary[id], m.Path)
		fmt.Fprintf(&table, "  %-40s %-22s %s\n", m.Path, m.Version, id)
		if forbidden[id] {
			problems = append(problems, fmt.Sprintf("%s %s: %s", m.Path, m.Version, id))
		}
		if f, ok := embedded[m.Path]; ok {
			extra, err := embeddedFS.ReadFile(f)
			if err != nil {
				return fmt.Errorf("%s: %w", m.Path, err)
			}
			text += "\n\n--- embedded native code (tools/notices/" + f + ") ---\n" + strings.TrimSpace(string(extra))
		}
		fmt.Fprintf(&body, "\n%s\n%s %s — %s\n%s\n\n%s\n", strings.Repeat("=", 80), m.Path, m.Version, id, strings.Repeat("=", 80), text)
	}
	fmt.Fprintln(&out, "Calab server — third-party notices")
	fmt.Fprintln(&out)
	fmt.Fprintln(&out, "The server binary includes the following Go modules. Their license texts follow, with the")
	fmt.Fprintln(&out, "notices of native code a module embeds (go-pdfium: PDFium in WebAssembly and its libraries).")
	fmt.Fprintln(&out, "Generated by `make third-party-notices` (apps/server/tools/notices); do not edit.")
	fmt.Fprintln(&out)
	ids := make([]string, 0, len(summary))
	for id := range summary {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	fmt.Fprintln(&out, "License audit: no GPL / LGPL / AGPL / SSPL / RSAL / BUSL (the generator fails on them).")
	for _, id := range ids {
		fmt.Fprintf(&out, "  %s: %d\n", id, len(summary[id]))
	}
	fmt.Fprintln(&out)
	fmt.Fprintf(&out, "  %-40s %-22s %s\n", "MODULE", "VERSION", "LICENSE")
	fmt.Fprint(&out, table.String())
	fmt.Fprint(&out, body.String())
	if _, err := io.WriteString(w, out.String()); err != nil {
		return err
	}
	if len(problems) > 0 {
		return fmt.Errorf("licenses that need review:\n  %s", strings.Join(problems, "\n  "))
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "notices:", err)
		os.Exit(1)
	}
}
