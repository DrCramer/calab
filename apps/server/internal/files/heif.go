package files

import (
	"encoding/binary"
	"errors"
	"io"
)

// HEIF (HEIC) helpers for POST /api/files/convert (docs/02 «Изображения: клиентское сжатие и
// HEIC»): sniffing the ISO-BMFF `ftyp` brands and reading the orientation of the primary
// item (`irot` / `imir` item properties), which ffmpeg does not apply to tile grids.

// heifBrands are the `ftyp` brands of HEIF still images (ISO/IEC 23008-12). AVIF shares
// `mif1` but browsers decode it themselves, so `avif` / `avis` make a file "not HEIF".
var heifBrands = map[string]bool{
	"heic": true, "heix": true, "heim": true, "heis": true,
	"hevc": true, "hevx": true, "hevm": true, "hevs": true,
	"mif1": true, "msf1": true,
}

// IsHEIF reports whether head (the first bytes of a file) starts a HEIF/HEIC image.
func IsHEIF(head []byte) bool {
	if len(head) < 16 || string(head[4:8]) != "ftyp" {
		return false
	}
	size := int(binary.BigEndian.Uint32(head[0:4]))
	if size < 16 || size > len(head) {
		size = len(head)
	}
	heif := false
	for off := 8; off+4 <= size; off += 4 {
		if off == 12 { // minor_version
			continue
		}
		b := string(head[off : off+4])
		if b == "avif" || b == "avis" {
			return false
		}
		heif = heif || heifBrands[b]
	}
	return heif
}

// IsAVIF reports whether head starts an AVIF image: an ISO-BMFF `ftyp` whose major or a
// compatible brand is `avif` (still) or `avis` (sequence).
func IsAVIF(head []byte) bool {
	if len(head) < 16 || string(head[4:8]) != "ftyp" {
		return false
	}
	size := int(binary.BigEndian.Uint32(head[0:4]))
	if size < 16 || size > len(head) {
		size = len(head)
	}
	for off := 8; off+4 <= size; off += 4 {
		if off == 12 { // minor_version
			continue
		}
		if b := string(head[off : off+4]); b == "avif" || b == "avis" {
			return true
		}
	}
	return false
}

// bmffBox is one ISO-BMFF box: its type and payload span within the file.
type bmffBox struct {
	typ      string
	off, end int64
}

var errBadBox = errors.New("malformed ISO-BMFF box")

// eachBox calls fn for the boxes in [off, end) of r; fn returning false stops the walk.
func eachBox(r io.ReaderAt, off, end int64, fn func(b bmffBox) (bool, error)) error {
	var hdr [16]byte
	for off+8 <= end {
		if _, err := r.ReadAt(hdr[:8], off); err != nil {
			return err
		}
		size := int64(binary.BigEndian.Uint32(hdr[:4]))
		typ := string(hdr[4:8])
		head := int64(8)
		switch size {
		case 0:
			size = end - off
		case 1:
			if _, err := r.ReadAt(hdr[8:16], off+8); err != nil {
				return err
			}
			size = int64(binary.BigEndian.Uint64(hdr[8:16])) //nolint:gosec // bounds-checked below
			head = 16
		}
		if size < head || off+size > end {
			return errBadBox
		}
		more, err := fn(bmffBox{typ: typ, off: off + head, end: off + size})
		if err != nil || !more {
			return err
		}
		off += size
	}
	return nil
}

// find returns the first child box of type typ in [off, end).
func find(r io.ReaderAt, off, end int64, typ string) (bmffBox, bool, error) {
	var got bmffBox
	found := false
	err := eachBox(r, off, end, func(b bmffBox) (bool, error) {
		if b.typ == typ {
			got, found = b, true
			return false, nil
		}
		return true, nil
	})
	return got, found, err
}

// readAt reads n bytes at off within box b.
func readAt(r io.ReaderAt, b bmffBox, off int64, n int) ([]byte, error) {
	if off < b.off || off+int64(n) > b.end {
		return nil, errBadBox
	}
	buf := make([]byte, n)
	_, err := r.ReadAt(buf, off)
	return buf, err
}

// heifOrientation returns the ffmpeg filters that apply the primary item's `irot` / `imir`
// properties (in their association order), or nil when there are none. A file without a
// readable `meta` box yields nil: ffmpeg then shows it as stored.
func heifOrientation(r io.ReaderAt, size int64) ([]string, error) {
	meta, ok, err := find(r, 0, size, "meta")
	if err != nil || !ok {
		return nil, err
	}
	body := meta.off + 4 // FullBox: version + flags
	pitm, ok, err := find(r, body, meta.end, "pitm")
	if err != nil || !ok {
		return nil, err
	}
	vf, err := readAt(r, pitm, pitm.off, 4)
	if err != nil {
		return nil, err
	}
	var primary uint32
	if vf[0] == 0 {
		b, err := readAt(r, pitm, pitm.off+4, 2)
		if err != nil {
			return nil, err
		}
		primary = uint32(binary.BigEndian.Uint16(b))
	} else {
		b, err := readAt(r, pitm, pitm.off+4, 4)
		if err != nil {
			return nil, err
		}
		primary = binary.BigEndian.Uint32(b)
	}
	iprp, ok, err := find(r, body, meta.end, "iprp")
	if err != nil || !ok {
		return nil, err
	}
	// ipco: the property boxes, addressed 1-based by ipma.
	ipco, ok, err := find(r, iprp.off, iprp.end, "ipco")
	if err != nil || !ok {
		return nil, err
	}
	var props []bmffBox
	if err := eachBox(r, ipco.off, ipco.end, func(b bmffBox) (bool, error) {
		props = append(props, b)
		return len(props) < 4096, nil
	}); err != nil {
		return nil, err
	}
	indices, err := primaryProps(r, iprp, primary)
	if err != nil {
		return nil, err
	}
	var filters []string
	for _, i := range indices {
		if i < 1 || i > len(props) {
			continue
		}
		p := props[i-1]
		switch p.typ {
		case "irot": // angle × 90° anticlockwise
			b, err := readAt(r, p, p.off, 1)
			if err != nil {
				return nil, err
			}
			switch b[0] & 3 {
			case 1:
				filters = append(filters, "transpose=cclock")
			case 2:
				filters = append(filters, "hflip", "vflip")
			case 3:
				filters = append(filters, "transpose=clock")
			}
		case "imir": // axis 0: vertical (left ↔ right), 1: horizontal (top ↔ bottom)
			b, err := readAt(r, p, p.off, 1)
			if err != nil {
				return nil, err
			}
			if b[0]&1 == 0 {
				filters = append(filters, "hflip")
			} else {
				filters = append(filters, "vflip")
			}
		}
	}
	return filters, nil
}

// primaryProps returns the ipco indices associated with item id in the ipma boxes of iprp.
func primaryProps(r io.ReaderAt, iprp bmffBox, id uint32) ([]int, error) {
	var out []int
	err := eachBox(r, iprp.off, iprp.end, func(b bmffBox) (bool, error) {
		if b.typ != "ipma" {
			return true, nil
		}
		vf, err := readAt(r, b, b.off, 8)
		if err != nil {
			return false, err
		}
		version, wide := vf[0], vf[3]&1 == 1
		count := binary.BigEndian.Uint32(vf[4:8])
		pos := b.off + 8
		for e := uint32(0); e < count && pos < b.end; e++ {
			var item uint32
			if version < 1 {
				v, err := readAt(r, b, pos, 2)
				if err != nil {
					return false, err
				}
				item, pos = uint32(binary.BigEndian.Uint16(v)), pos+2
			} else {
				v, err := readAt(r, b, pos, 4)
				if err != nil {
					return false, err
				}
				item, pos = binary.BigEndian.Uint32(v), pos+4
			}
			n, err := readAt(r, b, pos, 1)
			if err != nil {
				return false, err
			}
			pos++
			for a := 0; a < int(n[0]); a++ {
				var idx int
				if wide {
					v, err := readAt(r, b, pos, 2)
					if err != nil {
						return false, err
					}
					idx, pos = int(binary.BigEndian.Uint16(v)&0x7fff), pos+2
				} else {
					v, err := readAt(r, b, pos, 1)
					if err != nil {
						return false, err
					}
					idx, pos = int(v[0]&0x7f), pos+1
				}
				if item == id {
					out = append(out, idx)
				}
			}
		}
		return true, nil
	})
	return out, err
}
