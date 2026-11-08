package config

import (
	"fmt"
	"os"
	"strconv"
)

const (
	defaultDataDir  = "./data/harness"
	defaultMaxTurns = 25
)

type Config struct {
	APIKey      string
	BaseURL     string
	OctoKey     string
	Model       string
	DataDir     string
	Workspace   string
	RemoteBases []string
	MaxTurns    int
}

func Load() (Config, error) {
	cfg := Config{
		APIKey:   os.Getenv("ANTHROPIC_API_KEY"),
		BaseURL:  os.Getenv("ANTHROPIC_BASE_URL"),
		OctoKey:  os.Getenv("HARNESS_OCTO_KEY"),
		DataDir:  defaultDataDir,
		MaxTurns: defaultMaxTurns,
	}
	if v := os.Getenv("HARNESS_DATA_DIR"); v != "" {
		cfg.DataDir = v
	}
	if v := os.Getenv("HARNESS_MAX_TURNS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return Config{}, fmt.Errorf("HARNESS_MAX_TURNS: want positive integer, got %q", v)
		}
		cfg.MaxTurns = n
	}
	return cfg, nil
}
