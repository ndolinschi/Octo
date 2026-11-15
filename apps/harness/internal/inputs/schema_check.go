package inputs

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ndolinschi/Octo/apps/harness/internal/secrets"
)

// Messages under a refused field, in the card's words (spec A.3). They never
// hold a submitted value.
const (
	msgRequired = "Required"
	msgChoose   = "Choose one"
	msgConfirm  = "Confirm to continue"
	msgText     = "Enter text"
	msgNumber   = "Enter a number"
	msgWhole    = "Enter a whole number"
	msgYesNo    = "Answer yes or no"
	msgOption   = "Choose one of the options"
	msgList     = "Choose from the list"
	msgTwice    = "Choose each option once"
	msgEmail    = "Enter an email address like name@example.com"
	msgURI      = "Enter a web address starting with https://"
	msgDate     = "Enter a date like 2026-12-31"
	msgDateTime = "Enter a date and time"
	msgPattern  = "Doesn't match the expected format"
	msgUnknown  = "Not a field of this form"
	msgTooLong  = "Too long: at most 16 KiB"
)

// CheckAnswer validates an answer against a schema. Errors are by property id
// (nil when the answer is valid); unknown ids, hidden fields and wrong types are
// refused. Values come back typed: strings, float64 or int64, bool, []string.
func CheckAnswer(s Schema, a Answer) (Result, map[string]string) {
	if a.Skip {
		return Result{Status: StatusSkipped}, nil
	}
	res := Result{Status: StatusSubmitted, Values: map[string]any{}, Secrets: map[string]string{}}
	errs := map[string]string{}
	for id := range a.Values {
		if _, ok := s.Properties.Get(id); !ok {
			errs[unknownKey(id)] = msgUnknown
		}
	}
	shown := map[string]bool{}
	for _, np := range s.Properties {
		id, p := np.ID, np.Property
		var cond *Condition
		if p.Octo != nil {
			cond = p.Octo.VisibleWhen
		}
		shown[id] = visible(cond, a.Values, shown)
		v, given := a.Values[id]
		given = given && v != nil
		if !shown[id] {
			if given {
				errs[id] = answerHiddenField
			}
			continue
		}
		if missing(p, v, given) {
			if slices.Contains(s.Required, id) || (p.Octo != nil && p.Octo.Accept) {
				errs[id] = missingMessage(p)
			}
			continue
		}
		out, msg := checkValue(p, v)
		switch {
		case msg != "":
			errs[id] = msg
		case p.IsPassword():
			res.Secrets[id] = out.(string)
		default:
			res.Values[id] = out
		}
	}
	if len(errs) > 0 {
		return Result{}, errs
	}
	return res, nil
}

// unknownKey is how an unknown key is named back: as itself when it looks
// like an id, else a placeholder (a malformed key is not echoed).
func unknownKey(id string) string {
	if fieldID.MatchString(id) {
		return id
	}
	return "(unknown)"
}

func missing(p Property, v any, given bool) bool {
	if !given {
		return true
	}
	switch x := v.(type) {
	case string:
		return p.Type == typeString && strings.TrimSpace(x) == ""
	case []any:
		return p.Type == typeArray && len(x) == 0
	}
	return false
}

func missingMessage(p Property) string {
	switch {
	case p.Type == typeBoolean && p.Octo != nil && p.Octo.Accept:
		return msgConfirm
	case p.Type == typeArray:
		return fmt.Sprintf("Choose at least %d", max(1, deref(p.MinItems)))
	case p.choices() != nil:
		return msgChoose
	}
	return msgRequired
}

// checkValue checks one given, non-empty value; msg is "" when it fits.
func checkValue(p Property, v any) (any, string) {
	switch p.Type {
	case typeString:
		s, ok := v.(string)
		if !ok && p.choices() != nil {
			return nil, msgOption
		}
		if !ok {
			return nil, msgText
		}
		return s, checkString(p, s)
	case typeNumber, typeInteger:
		f, ok := v.(float64)
		if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
			return nil, msgNumber
		}
		if p.Type == typeInteger && f != math.Trunc(f) {
			return nil, msgWhole
		}
		if (p.Minimum != nil && f < *p.Minimum) || (p.Maximum != nil && f > *p.Maximum) {
			return nil, rangeMessage(p)
		}
		if p.Type == typeInteger && math.Abs(f) < maxSafeInteger {
			return int64(f), ""
		}
		return f, ""
	case typeBoolean:
		b, ok := v.(bool)
		if !ok {
			return nil, msgYesNo
		}
		if p.Octo != nil && p.Octo.Accept && !b {
			return nil, msgConfirm
		}
		return b, ""
	case typeArray:
		return checkArray(p, v)
	}
	return nil, msgUnknown
}

func checkString(p Property, s string) string {
	if len(s) > MaxTextBytes {
		return msgTooLong
	}
	if c := p.choices(); c != nil {
		if !slices.Contains(c, s) {
			return msgOption
		}
		return ""
	}
	n := utf8.RuneCountInString(s)
	switch {
	case p.IsPassword() && len(s) < secrets.MinLen:
		return fmt.Sprintf("Use %d characters or more", secrets.MinLen)
	case p.MinLength != nil && n < *p.MinLength:
		return fmt.Sprintf("Use %d characters or more", *p.MinLength)
	case p.MaxLength != nil && n > *p.MaxLength:
		return fmt.Sprintf("Use %d characters or fewer", *p.MaxLength)
	case p.Format == formatEmail && !IsEmail(s):
		return msgEmail
	case p.Format == formatURI && !IsURI(s):
		return msgURI
	case p.Format == formatDate && !isDate(s):
		return msgDate
	case p.Format == formatDateTime && !isDateTime(s):
		return msgDateTime
	}
	if p.Pattern != "" {
		re, err := regexp.Compile(p.Pattern)
		if err != nil || !re.MatchString(s) {
			return msgPattern
		}
	}
	return ""
}

func checkArray(p Property, v any) (any, string) {
	list, ok := v.([]any)
	if !ok {
		return nil, msgList
	}
	out := make([]string, 0, len(list))
	for _, x := range list {
		s, ok := x.(string)
		if !ok || !slices.Contains(p.choices(), s) {
			return nil, msgList
		}
		if slices.Contains(out, s) {
			return nil, msgTwice
		}
		out = append(out, s)
	}
	if p.MinItems != nil && len(out) < *p.MinItems {
		return nil, fmt.Sprintf("Choose at least %d", *p.MinItems)
	}
	if p.MaxItems != nil && len(out) > *p.MaxItems {
		return nil, fmt.Sprintf("Choose at most %d", *p.MaxItems)
	}
	return out, ""
}

func rangeMessage(p Property) string {
	num := func(f *float64) string { return strconv.FormatFloat(*f, 'f', -1, 64) }
	switch {
	case p.Minimum != nil && p.Maximum != nil:
		return fmt.Sprintf("Enter a number from %s to %s", num(p.Minimum), num(p.Maximum))
	case p.Minimum != nil:
		return fmt.Sprintf("Enter a number of at least %s", num(p.Minimum))
	}
	return fmt.Sprintf("Enter a number of at most %s", num(p.Maximum))
}

func deref(n *int) int {
	if n == nil {
		return 0
	}
	return *n
}

// IsEmail: one "@", no white space, a non-empty local part, a domain with a
// dot that neither starts nor ends with one and has no empty label.
func IsEmail(s string) bool {
	local, domain, ok := strings.Cut(s, "@")
	return ok && local != "" && !strings.Contains(domain, "@") && !strings.ContainsFunc(s, isSpace) &&
		strings.Contains(domain, ".") && !strings.HasPrefix(domain, ".") && !strings.HasSuffix(domain, ".") &&
		!strings.Contains(domain, "..")
}

var uriScheme = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:`)

// IsURI: absolute with a scheme, no white space, something after the colon;
// with "//" after the scheme the host part must not be empty.
func IsURI(s string) bool {
	m := uriScheme.FindString(s)
	if m == "" || strings.ContainsFunc(s, isSpace) {
		return false
	}
	rest := s[len(m):]
	if after, ok := strings.CutPrefix(rest, "//"); ok {
		host, _, _ := strings.Cut(after, "/")
		host, _, _ = strings.Cut(host, "?")
		host, _, _ = strings.Cut(host, "#")
		return host != ""
	}
	return rest != ""
}

func isSpace(r rune) bool {
	return r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\f' || r == '\v'
}

func isDate(s string) bool {
	_, err := time.Parse(time.DateOnly, s)
	return err == nil
}

func isDateTime(s string) bool {
	_, err := time.Parse(time.RFC3339, s)
	return err == nil
}
