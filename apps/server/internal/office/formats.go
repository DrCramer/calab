package office

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"path"
	"slices"
	"strings"
	"unicode/utf8"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Format is one extension of the map: the only place that decides what opens in the editor and
// how (ADR-0143 «Форматы»). Checked against ONLYOFFICE Docs 10.0 and its format list
// github.com/ONLYOFFICE/document-formats (onlyoffice-docs-formats.json): «edit» is a native
// format, «lossy-edit» is saved back in its own format with possible losses, «auto-convert» is
// opened through a conversion.
type Format struct {
	Ext string
	// DocType is the Document Server's documentType: word, cell, slide, pdf.
	DocType string
	Cap     v1.OfficeCapability
	// ConvertTo is what «Сохранить как» produces (CONVERT only).
	ConvertTo string
	// Lossy: edited in place in a format that is not OOXML (the Document Server's lossy-edit).
	Lossy bool
	// Mime is the stored type of a file saved in this format.
	Mime string
	// check validates the bytes of a saved / converted file of this format.
	check func([]byte) error
}

const (
	mimeDocx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	mimeXlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	mimePptx = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
	mimeOdt  = "application/vnd.oasis.opendocument.text"
	mimeOds  = "application/vnd.oasis.opendocument.spreadsheet"
	mimeOdp  = "application/vnd.oasis.opendocument.presentation"
)

var (
	capEdit    = v1.OfficeCapability_OFFICE_CAPABILITY_EDIT
	capView    = v1.OfficeCapability_OFFICE_CAPABILITY_VIEW
	capConvert = v1.OfficeCapability_OFFICE_CAPABILITY_CONVERT
)

// formats is the map. Edited in place: the OOXML trio (native «edit») and odt, ods, odp, rtf,
// csv, txt («lossy-edit» in Community too). Legacy doc, xls, ppt open read-only and convert to a
// new OOXML item: saving them in place is either impossible (doc, ppt: view + auto-convert only)
// or would rewrite a binary format the bots cannot read reliably (xls is lossy-edit, kept out on
// purpose). pdf: view only (the PDF editor is out of scope). Nothing else opens.
var formats = []Format{
	{Ext: "docx", DocType: "word", Cap: capEdit, Mime: mimeDocx, check: ooxml("word/document.xml")},
	{Ext: "xlsx", DocType: "cell", Cap: capEdit, Mime: mimeXlsx, check: ooxml("xl/workbook.xml")},
	{Ext: "pptx", DocType: "slide", Cap: capEdit, Mime: mimePptx, check: ooxml("ppt/presentation.xml")},
	{Ext: "odt", DocType: "word", Cap: capEdit, Lossy: true, Mime: mimeOdt, check: odf(mimeOdt)},
	{Ext: "ods", DocType: "cell", Cap: capEdit, Lossy: true, Mime: mimeOds, check: odf(mimeOds)},
	{Ext: "odp", DocType: "slide", Cap: capEdit, Lossy: true, Mime: mimeOdp, check: odf(mimeOdp)},
	{Ext: "rtf", DocType: "word", Cap: capEdit, Lossy: true, Mime: "application/rtf", check: rtf},
	{Ext: "csv", DocType: "cell", Cap: capEdit, Lossy: true, Mime: "text/csv", check: plainText},
	{Ext: "txt", DocType: "word", Cap: capEdit, Lossy: true, Mime: "text/plain", check: plainText},
	{Ext: "doc", DocType: "word", Cap: capConvert, ConvertTo: "docx"},
	{Ext: "xls", DocType: "cell", Cap: capConvert, ConvertTo: "xlsx"},
	{Ext: "ppt", DocType: "slide", Cap: capConvert, ConvertTo: "pptx"},
	{Ext: "pdf", DocType: "pdf", Cap: capView},
}

// ext is the lower-case extension of a file name ("" without one).
func ext(name string) string { return strings.ToLower(strings.TrimPrefix(path.Ext(name), ".")) }

// FormatOf is the map's entry of a file name (ok=false: no editor).
func FormatOf(name string) (Format, bool) { return formatByExt(ext(name)) }

func formatByExt(e string) (Format, bool) {
	i := slices.IndexFunc(formats, func(f Format) bool { return f.Ext == e })
	if i < 0 || e == "" {
		return Format{}, false
	}
	return formats[i], true
}

func (f Format) proto() *v1.OfficeFormat {
	return &v1.OfficeFormat{Extension: f.Ext, DocumentType: f.DocType, Capability: f.Cap, ConvertTo: f.ConvertTo, Lossy: f.Lossy}
}

// Formats is the map for the client (GET /api/office/capabilities).
func Formats() []*v1.OfficeFormat {
	out := make([]*v1.OfficeFormat, len(formats))
	for i, f := range formats {
		out[i] = f.proto()
	}
	return out
}

// errContent: the saved bytes are not a file of the expected format.
var errContent = errors.New("office: the saved file is not of its format")

// Check validates body as a file of f (formats that are never written have no check: refused).
func (f Format) Check(body []byte) error {
	if f.check == nil {
		return errContent
	}
	return f.check(body)
}

// zipNames opens body as a zip (central directory only, nothing is inflated except what fn
// reads) and returns its reader.
func zipOf(body []byte) (*zip.Reader, error) {
	if !bytes.HasPrefix(body, []byte("PK\x03\x04")) {
		return nil, errContent
	}
	z, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		return nil, errContent
	}
	return z, nil
}

func hasEntry(z *zip.Reader, name string) bool {
	return slices.ContainsFunc(z.File, func(f *zip.File) bool { return f.Name == name })
}

// ooxml: a zip with [Content_Types].xml and the format's main part.
func ooxml(part string) func([]byte) error {
	return func(b []byte) error {
		z, err := zipOf(b)
		if err != nil {
			return err
		}
		if !hasEntry(z, "[Content_Types].xml") || !hasEntry(z, part) {
			return errContent
		}
		return nil
	}
}

// odf: a zip whose "mimetype" entry holds the format's type (ODF 1.2 §3.3).
func odf(mime string) func([]byte) error {
	return func(b []byte) error {
		z, err := zipOf(b)
		if err != nil {
			return err
		}
		for _, f := range z.File {
			if f.Name != "mimetype" || f.UncompressedSize64 > 128 {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return errContent
			}
			got, err := io.ReadAll(io.LimitReader(rc, 128))
			_ = rc.Close()
			if err == nil && string(got) == mime && hasEntry(z, "content.xml") {
				return nil
			}
			return errContent
		}
		return errContent
	}
}

func rtf(b []byte) error {
	if !bytes.HasPrefix(b, []byte(`{\rtf`)) {
		return errContent
	}
	return nil
}

// plainText: UTF-8 (a BOM allowed) without NUL bytes: never a binary passed off as csv / txt.
func plainText(b []byte) error {
	b = bytes.TrimPrefix(b, []byte("\xef\xbb\xbf"))
	if bytes.IndexByte(b, 0) >= 0 || !utf8.Valid(b) {
		return errContent
	}
	return nil
}
