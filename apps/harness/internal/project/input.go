package project

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"

	"github.com/ndolinschi/Octo/apps/harness/internal/config"
	"github.com/ndolinschi/Octo/apps/harness/internal/projectstore"
)

type FolderInput struct {
	Path  string `json:"path"`
	Label string `json:"label"`
}

// Input is a create or partial-update body; nil means "not provided".
type Input struct {
	Name         *string        `json:"name"`
	Description  *string        `json:"description"`
	Instructions *string        `json:"instructions"`
	Folders      *[]FolderInput `json:"folders"`
	Models       *config.Models `json:"models"`
	MaxDepth     *int           `json:"max_depth"`
	// BudgetUSD is the project's spend cap; JSON null removes it.
	BudgetUSD OptionalFloat `json:"budget_usd"`
}

// OptionalFloat distinguishes an absent JSON field from an explicit null.
type OptionalFloat struct {
	Set   bool
	Value *float64
}

func (o *OptionalFloat) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		o.Value = nil
		return nil
	}
	var v float64
	if err := json.Unmarshal(b, &v); err != nil {
		return fmt.Errorf("budget_usd must be a number or null")
	}
	o.Value = &v
	return nil
}

func validBudget(o OptionalFloat) error {
	if o.Set && o.Value != nil && (!(*o.Value > 0) || math.IsInf(*o.Value, 0)) {
		return invalid("budget_usd must be greater than 0, or null to remove the budget")
	}
	return nil
}

func validDepth(n int) error {
	if n < 1 || n > config.MaxDepthLimit {
		return invalid("max_depth must be between 1 and %d", config.MaxDepthLimit)
	}
	return nil
}

// mergeModels overlays the non-empty entries of over onto base.
func mergeModels(base config.Models, over *config.Models) (config.Models, error) {
	if over == nil {
		return base, nil
	}
	if over.TierPolicy != "" && !config.ValidTierPolicy(over.TierPolicy) {
		return base, invalid("models.tier_policy must be auto, ceiling or fixed")
	}
	for dst, src := range map[*string]string{
		&base.Orchestrator: over.Orchestrator, &base.Fast: over.Fast,
		&base.Balanced: over.Balanced, &base.Deep: over.Deep, &base.TierPolicy: over.TierPolicy, &base.Side: over.Side,
	} {
		if src != "" {
			*dst = src
		}
	}
	return base, nil
}

// resolveFolders validates paths and assigns unique labels (basename by default).
func resolveFolders(in []FolderInput) ([]projectstore.Folder, error) {
	out := make([]projectstore.Folder, 0, len(in))
	used := make(map[string]bool)
	for _, f := range in {
		if !filepath.IsAbs(f.Path) {
			return nil, invalid("folder path %q must be absolute", f.Path)
		}
		clean := filepath.Clean(f.Path)
		st, err := os.Stat(clean)
		if err != nil || !st.IsDir() {
			return nil, invalid("folder path %q is not an existing directory", f.Path)
		}
		label := f.Label
		if label != "" && used[label] {
			return nil, invalid("duplicate folder label %q", label)
		}
		if label == "" {
			label = uniqueLabel(filepath.Base(clean), used)
		}
		used[label] = true
		out = append(out, projectstore.Folder{Label: label, Path: clean})
	}
	return out, nil
}

func uniqueLabel(base string, used map[string]bool) string {
	label := base
	for n := 2; used[label]; n++ {
		label = base + "-" + strconv.Itoa(n)
	}
	return label
}
