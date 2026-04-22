// Package axon is the official Go client for Axon — the universal API
// gateway for AI agents.
//
//	client := axon.New(axon.Options{APIKey: os.Getenv("AXON_KEY")})
//	res, err := client.Call(ctx, "serpapi", "search",
//	    axon.Params{"q": "espresso in lisbon"}, nil)
//	if err != nil { log.Fatal(err) }
//	fmt.Println(res.CostUSDC, res.CacheHit, res.Data)
package axon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

const defaultBaseURL = "https://api.axon.dev"

// Options configure the client.
type Options struct {
	APIKey     string
	BaseURL    string        // default: https://api.axon.dev
	HTTPClient *http.Client  // default: &http.Client{Timeout: 30s}
	UserAgent  string        // default: axon-go/0.1
}

// Client is the Axon API client.
type Client struct {
	apiKey    string
	baseURL   string
	http      *http.Client
	userAgent string
}

// Params is a convenience type for query-string / key-value arguments.
type Params map[string]any

// Error is a structured error returned by the Axon API.
type Error struct {
	Status  int            `json:"-"`
	Code    string         `json:"error"`
	Message string         `json:"message"`
	Meta    map[string]any `json:"meta,omitempty"`
}

func (e *Error) Error() string {
	return fmt.Sprintf("axon: %s (%d): %s", e.Code, e.Status, e.Message)
}

// Result is the outcome of a Call.
type Result struct {
	Data      any
	CostUSDC  string
	CacheHit  bool
	LatencyMs int
	Status    int
	Headers   http.Header
}

// Balance describes a wallet snapshot.
type Balance struct {
	Address       string `json:"address"`
	BalanceUSDC   string `json:"balance_usdc"`
	ReservedUSDC  string `json:"reserved_usdc"`
	AvailableUSDC string `json:"available_usdc"`
}

// ApiCatalogEntry is one item in the catalog.
type ApiCatalogEntry struct {
	Slug        string   `json:"slug"`
	Provider    string   `json:"provider"`
	Category    string   `json:"category"`
	Description string   `json:"description"`
	Endpoints   []string `json:"endpoints"`
}

// New builds a client from Options. Panics on missing API key.
func New(o Options) *Client {
	if o.APIKey == "" {
		panic("axon: APIKey is required")
	}
	if o.BaseURL == "" {
		o.BaseURL = defaultBaseURL
	}
	if o.HTTPClient == nil {
		o.HTTPClient = &http.Client{Timeout: 30 * time.Second}
	}
	if o.UserAgent == "" {
		o.UserAgent = "axon-go/0.1"
	}
	return &Client{
		apiKey:    o.APIKey,
		baseURL:   o.BaseURL,
		http:      o.HTTPClient,
		userAgent: o.UserAgent,
	}
}

// do runs a request and parses JSON into `out` when non-nil.
func (c *Client) do(ctx context.Context, method, path string, body any, out any) (*http.Response, error) {
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reqBody = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-api-key", c.apiKey)
	req.Header.Set("user-agent", c.userAgent)
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}

	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}

	if res.StatusCode >= 400 {
		defer res.Body.Close()
		e := &Error{Status: res.StatusCode}
		_ = json.NewDecoder(res.Body).Decode(e)
		if e.Code == "" {
			e.Code = "http_error"
			e.Message = http.StatusText(res.StatusCode)
		}
		return res, e
	}

	if out != nil {
		defer res.Body.Close()
		if err := json.NewDecoder(res.Body).Decode(out); err != nil {
			return res, err
		}
	}
	return res, nil
}

// Call invokes an Axon-proxied API. If body is non-nil, the call uses POST.
func (c *Client) Call(ctx context.Context, slug, endpoint string, params Params, body any) (*Result, error) {
	path := fmt.Sprintf("/v1/call/%s/%s", slug, endpoint)
	if len(params) > 0 && body == nil {
		q := url.Values{}
		for k, v := range params {
			q.Set(k, fmt.Sprint(v))
		}
		path += "?" + q.Encode()
	}

	var raw json.RawMessage
	method := http.MethodGet
	if body != nil {
		method = http.MethodPost
	}

	res, err := c.do(ctx, method, path, body, &raw)
	if err != nil {
		return nil, err
	}

	var parsed any
	_ = json.Unmarshal(raw, &parsed)

	latency, _ := strconv.Atoi(res.Header.Get("x-axon-latency-ms"))
	return &Result{
		Data:      parsed,
		CostUSDC:  res.Header.Get("x-axon-cost-usdc"),
		CacheHit:  res.Header.Get("x-axon-cache") == "hit",
		LatencyMs: latency,
		Status:    res.StatusCode,
		Headers:   res.Header,
	}, nil
}

// Balance returns the caller's wallet balance.
func (c *Client) Balance(ctx context.Context) (*Balance, error) {
	var b Balance
	_, err := c.do(ctx, http.MethodGet, "/v1/wallet/balance", nil, &b)
	return &b, err
}

// Catalog lists every API available.
func (c *Client) Catalog(ctx context.Context) ([]ApiCatalogEntry, error) {
	var wrap struct {
		Data []ApiCatalogEntry `json:"data"`
	}
	_, err := c.do(ctx, http.MethodGet, "/v1/apis", nil, &wrap)
	return wrap.Data, err
}

// IsNotFound is a helper for callers that want to branch on error codes.
func IsNotFound(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == "not_found"
}

// IsInsufficientFunds likewise.
func IsInsufficientFunds(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == "insufficient_funds"
}
