# axon-go

Official Go client for [Axon](https://axon.dev).

## Install

```bash
go get github.com/axondev/axon-go
```

## Quick start

```go
package main

import (
    "context"
    "fmt"
    "log"
    "os"

    "github.com/axondev/axon-go"
)

func main() {
    client := axon.New(axon.Options{APIKey: os.Getenv("AXON_KEY")})

    ctx := context.Background()

    // GET with params
    res, err := client.Call(ctx, "serpapi", "search",
        axon.Params{"q": "best espresso in lisbon"}, nil)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("paid %s USDC, cache hit=%v\n", res.CostUSDC, res.CacheHit)

    // POST with body
    chat, err := client.Call(ctx, "openai", "chat", nil, map[string]any{
        "model":    "gpt-4o-mini",
        "messages": []map[string]string{{"role": "user", "content": "Hi!"}},
    })
    _ = chat

    // Wallet
    b, _ := client.Balance(ctx)
    fmt.Println(b.AvailableUSDC)
}
```

## Error handling

```go
if err != nil {
    if axon.IsInsufficientFunds(err) {
        // top up wallet
    }
}
```

## License

MIT
