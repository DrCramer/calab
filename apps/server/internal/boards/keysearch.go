package boards

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// KeyQuery is a search string read as a task key in any spelling (docs/09 #88): «DOC-532»,
// «doc532», «doc 532», «doc_532», «док-532», «штм-820», or just «532».
type KeyQuery struct {
	// Prefixes: the board keys the letters may mean (upper case, valid keys); empty for a bare number.
	Prefixes []string
	Number   int32
}

var (
	looseKeyRE = regexp.MustCompile(`^#?([\p{L}][\p{L}0-9]*?)[\s_\-]*(\d{1,9})$`)
	bareNumRE  = regexp.MustCompile(`^#?(\d{1,9})$`)
)

// maxPrefixVariants bounds the phonetic spellings of one Cyrillic prefix.
const maxPrefixVariants = 48

// ParseLooseKey reads raw as a task key. The letters are matched case-insensitively; Cyrillic
// letters mean the same keys typed on the Russian layout (штм → INV: the same keys) or read by
// sound (док → DOC). It is a pure function of the text: no lookup, the SQL compares b.key.
func ParseLooseKey(raw string) (KeyQuery, bool) {
	raw = strings.TrimSpace(raw)
	if m := bareNumRE.FindStringSubmatch(raw); m != nil {
		n, err := strconv.ParseInt(m[1], 10, 32)
		if err != nil || n < 1 {
			return KeyQuery{}, false
		}
		return KeyQuery{Number: int32(n)}, true
	}
	m := looseKeyRE.FindStringSubmatch(raw)
	if m == nil {
		return KeyQuery{}, false
	}
	n, err := strconv.ParseInt(m[2], 10, 32)
	if err != nil || n < 1 {
		return KeyQuery{}, false
	}
	var out []string
	for _, p := range prefixVariants(strings.ToUpper(m[1])) {
		if keyRE.MatchString(p) {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return KeyQuery{}, false
	}
	return KeyQuery{Prefixes: out, Number: int32(n)}, true
}

// prefixVariants: the prefix itself when it is Latin; for a Cyrillic one the same keys on the
// QWERTY layout and the phonetic spellings.
func prefixVariants(p string) []string {
	rs := []rune(p)
	cyr := false
	for _, r := range rs {
		if r > unicode.MaxASCII {
			cyr = true
		}
	}
	if !cyr {
		return []string{p}
	}
	var kb strings.Builder
	kbOK := true
	for _, r := range rs {
		switch {
		case r <= unicode.MaxASCII:
			kb.WriteRune(r)
		case qwerty[r] != 0:
			kb.WriteRune(qwerty[r])
		default:
			kbOK = false
		}
	}
	var out []string
	if kbOK {
		out = append(out, kb.String())
	}
	ph := []string{""}
	for _, r := range rs {
		opts := []string{string(r)}
		if r > unicode.MaxASCII {
			var ok bool
			if opts, ok = phonetic[r]; !ok {
				return out
			}
		}
		var next []string
		for _, base := range ph {
			for _, o := range opts {
				if len(next) < maxPrefixVariants {
					next = append(next, base+o)
				}
			}
		}
		ph = next
	}
	for _, v := range ph {
		dup := false
		for _, o := range out {
			dup = dup || o == v
		}
		if !dup {
			out = append(out, v)
		}
	}
	return out
}

// qwerty: the letter keys of the ЙЦУКЕН layout → the QWERTY letters on the same keys.
var qwerty = map[rune]rune{
	'Й': 'Q', 'Ц': 'W', 'У': 'E', 'К': 'R', 'Е': 'T', 'Н': 'Y', 'Г': 'U', 'Ш': 'I', 'Щ': 'O', 'З': 'P',
	'Ф': 'A', 'Ы': 'S', 'В': 'D', 'А': 'F', 'П': 'G', 'Р': 'H', 'О': 'J', 'Л': 'K', 'Д': 'L',
	'Я': 'Z', 'Ч': 'X', 'С': 'C', 'М': 'V', 'И': 'B', 'Т': 'N', 'Ь': 'M',
}

// phonetic: the Latin letters a Cyrillic one is read as when a key like DOC is typed by sound.
var phonetic = map[rune][]string{
	'А': {"A"}, 'Б': {"B"}, 'В': {"V", "W"}, 'Г': {"G"}, 'Д': {"D"}, 'Е': {"E"}, 'Ё': {"E"}, 'Ж': {"J", "Z"},
	'З': {"Z"}, 'И': {"I"}, 'Й': {"Y", "J"}, 'К': {"K", "C"}, 'Л': {"L"}, 'М': {"M"}, 'Н': {"N"}, 'О': {"O"},
	'П': {"P"}, 'Р': {"R"}, 'С': {"S", "C"}, 'Т': {"T"}, 'У': {"U", "Y"}, 'Ф': {"F"}, 'Х': {"H", "X"},
	'Ц': {"C"}, 'Ч': {"C"}, 'Ш': {"S"}, 'Щ': {"S"}, 'Ъ': {""}, 'Ы': {"Y"}, 'Ь': {""}, 'Э': {"E"}, 'Ю': {"U"}, 'Я': {"Y", "A"},
}

// KeyMatchSQL is the condition over tasks t (JOIN boards b) of a task whose key the query
// spells: the number on a board whose key is one of the prefixes, or, for a bare number, the
// number on any board (the caller ANDs the visibility).
func (k KeyQuery) KeyMatchSQL(a *Args) string {
	if len(k.Prefixes) == 0 {
		return "t.number = " + a.Add(k.Number)
	}
	return "(t.number = " + a.Add(k.Number) + " AND b.key = ANY(" + a.Add(k.Prefixes) + "::text[]))"
}
