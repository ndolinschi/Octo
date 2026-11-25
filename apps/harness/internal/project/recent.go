package project

import (
	"context"
	"os"
)

// RecentFolders lists the folder paths of existing projects, most recently
// updated project first, without repeats and without folders that no longer
// exist, at most max.
func (s *Service) RecentFolders(ctx context.Context, max int) ([]string, error) {
	list, err := s.List(ctx)
	if err != nil {
		return nil, err
	}
	var out []string
	seen := map[string]bool{}
	for _, sum := range list {
		p, err := s.Get(ctx, sum.ID)
		if err != nil {
			return nil, err
		}
		for _, f := range p.Folders {
			if seen[f.Path] {
				continue
			}
			seen[f.Path] = true
			if st, err := os.Stat(f.Path); err != nil || !st.IsDir() {
				continue
			}
			if out = append(out, f.Path); len(out) >= max {
				return out, nil
			}
		}
	}
	return out, nil
}
