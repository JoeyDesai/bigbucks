/**
 * The "Add an investment" picker's built-in list: the main cryptos (priced by Coinbase) and widely held
 * ETFs, index funds and stocks (priced by Yahoo Finance). Anything else is found with live search.
 */
export type AssetType = "crypto" | "etf" | "fund" | "stock";

export interface AssetOption {
  source: "coinbase" | "yahoo";
  symbol: string;
  name: string;
  type: AssetType;
}

const c = (symbol: string, name: string): AssetOption => ({ source: "coinbase", symbol, name, type: "crypto" });
const y = (type: Exclude<AssetType, "crypto">) => (symbol: string, name: string): AssetOption => ({ source: "yahoo", symbol, name, type });
const etf = y("etf");
const fund = y("fund");
const stock = y("stock");

export const ASSET_TYPE_LABEL: Record<AssetType, string> = { crypto: "Crypto", etf: "ETF", fund: "Mutual fund", stock: "Stock" };

export const ASSETS: readonly AssetOption[] = [
  c("BTC", "Bitcoin"),
  c("ETH", "Ethereum"),
  c("SOL", "Solana"),
  c("XRP", "XRP"),
  c("DOGE", "Dogecoin"),
  c("ADA", "Cardano"),
  c("AVAX", "Avalanche"),
  c("LINK", "Chainlink"),
  c("LTC", "Litecoin"),
  c("DOT", "Polkadot"),
  c("BCH", "Bitcoin Cash"),
  c("XLM", "Stellar"),
  c("SHIB", "Shiba Inu"),
  c("SUI", "Sui"),
  c("HBAR", "Hedera"),
  c("UNI", "Uniswap"),
  c("AAVE", "Aave"),
  c("ATOM", "Cosmos"),
  c("USDC", "USD Coin"),
  etf("VOO", "Vanguard S&P 500 ETF"),
  etf("VTI", "Vanguard Total Stock Market ETF"),
  etf("SPY", "SPDR S&P 500 ETF"),
  etf("IVV", "iShares Core S&P 500 ETF"),
  etf("QQQ", "Invesco QQQ (Nasdaq-100)"),
  etf("VXUS", "Vanguard Total International Stock ETF"),
  etf("VT", "Vanguard Total World Stock ETF"),
  etf("BND", "Vanguard Total Bond Market ETF"),
  etf("SCHD", "Schwab US Dividend Equity ETF"),
  etf("VUG", "Vanguard Growth ETF"),
  etf("VIG", "Vanguard Dividend Appreciation ETF"),
  etf("IWM", "iShares Russell 2000 ETF"),
  etf("GLD", "SPDR Gold Shares"),
  etf("IBIT", "iShares Bitcoin Trust"),
  etf("FBTC", "Fidelity Wise Origin Bitcoin Fund"),
  fund("FXAIX", "Fidelity 500 Index Fund"),
  fund("FSKAX", "Fidelity Total Market Index Fund"),
  fund("FZROX", "Fidelity ZERO Total Market Index Fund"),
  fund("FTIHX", "Fidelity Total International Index Fund"),
  fund("FZILX", "Fidelity ZERO International Index Fund"),
  fund("FCNTX", "Fidelity Contrafund"),
  fund("VFIAX", "Vanguard 500 Index Fund Admiral"),
  fund("VTSAX", "Vanguard Total Stock Market Index Admiral"),
  fund("VTIAX", "Vanguard Total International Stock Index Admiral"),
  fund("VBTLX", "Vanguard Total Bond Market Index Admiral"),
  fund("SWPPX", "Schwab S&P 500 Index Fund"),
  fund("SWTSX", "Schwab Total Stock Market Index Fund"),
  stock("AAPL", "Apple"),
  stock("MSFT", "Microsoft"),
  stock("NVDA", "NVIDIA"),
  stock("AMZN", "Amazon"),
  stock("GOOGL", "Alphabet (Google)"),
  stock("META", "Meta Platforms"),
  stock("TSLA", "Tesla"),
  stock("BRK-B", "Berkshire Hathaway B"),
  stock("JPM", "JPMorgan Chase"),
  stock("COST", "Costco"),
  stock("SBUX", "Starbucks"),
];

/** Built-in matches for a query: symbol prefix first, then name words. */
export function matchAssets(q: string, limit = 8): AssetOption[] {
  const s = q.trim().toLowerCase();
  if (!s) return ASSETS.slice(0, limit);
  const score = (a: AssetOption) => {
    const sym = a.symbol.toLowerCase();
    const name = a.name.toLowerCase();
    if (sym === s) return 0;
    if (sym.startsWith(s)) return 1;
    if (name.startsWith(s)) return 2;
    if (name.split(/[\s()&-]+/).some((w) => w.startsWith(s))) return 3;
    if (name.includes(s)) return 4;
    return 9;
  };
  return ASSETS.map((a) => [a, score(a)] as const)
    .filter(([, n]) => n < 9)
    .sort((a, b) => a[1] - b[1])
    .slice(0, limit)
    .map(([a]) => a);
}
