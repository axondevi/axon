// Minimal Axon Go example.
//   AXON_KEY=ax_live_... go run go-minimal.go
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

	res, err := client.Call(ctx, "openweather", "current",
		axon.Params{"lat": 38.72, "lon": -9.14}, nil)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("paid %s USDC cache=%v\n", res.CostUSDC, res.CacheHit)

	bal, err := client.Balance(ctx)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("wallet: %s USDC available\n", bal.AvailableUSDC)
}
