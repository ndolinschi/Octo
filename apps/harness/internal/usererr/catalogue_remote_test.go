package usererr

import (
	"strings"
	"testing"
	"unicode"
)

// TestRemoteWording holds every remote-access code to the catalogue's wording rules.
func TestRemoteWording(t *testing.T) {
	seen := map[string]bool{}
	for _, code := range RemoteCodes() {
		e := Remote(code)
		if e.Code != code {
			t.Errorf("%s: code %q", code, e.Code)
		}
		if e.Message == "Remote access refused this." {
			t.Errorf("%s: falls through to the default wording", code)
		}
		if seen[e.Message] {
			t.Errorf("%s: message %q is used twice", code, e.Message)
		}
		seen[e.Message] = true
		for _, s := range []string{e.Message, e.Hint} {
			for _, re := range forbidden {
				if re.MatchString(s) {
					t.Errorf("%s: %q matches forbidden %q", code, s, re)
				}
			}
			if r := []rune(s); !unicode.IsUpper(r[0]) || !strings.HasSuffix(s, ".") || len(r) > 140 {
				t.Errorf("%s: %q breaks the sentence rules", code, s)
			}
		}
	}
}
