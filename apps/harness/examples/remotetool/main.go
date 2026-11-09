package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
)

func main() {
	addr := flag.String("addr", ":0", "listen address")
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /tools", handleTools)
	mux.HandleFunc("POST /tools/echo", handleEcho)

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(ln.Addr().String())
	if err := http.Serve(ln, mux); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func handleTools(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `[{"name":"echo","description":"Echo text back","input_schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}]`)
}

func handleEcho(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text string `json:"text"`
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := json.Unmarshal(body, &in); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(in.Text))
}
