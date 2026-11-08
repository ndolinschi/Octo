package config

import "os"

const (
	defaultDataDir  = "./data/harness"
	defaultMaxTurns = 25
)

type Config struct {
	APIKey      string
	BaseURL     string
	Model       string
	DataDir     string
	Workspace   string
	RemoteBases []string
	MaxTurns    int
}

func Load() (Config, error) {
	cfg := Config{
		APIKey:    os.Getenv("ANTHROPIC_API_KEY"),
		BaseURL:   os.Getenv("ANTHROPIC_BASE_URL"),
		DataDir:   defaultDataDir,
		MaxTurns:  defaultMaxTurns,
	}
	if v := os.Getenv("HARNESS_DATA_DIR"); v != "" {
		cfg.DataDir = v
	}
	return cfg, nil
}
