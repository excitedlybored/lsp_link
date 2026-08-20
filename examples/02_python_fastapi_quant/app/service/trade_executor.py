import uuid
from app.egress.trade_store import TradeStore
from app.egress.clearing_house_client import ClearingHouseClient

class TradeExecutor:
    """Core Domain Service: Connects Ingress requests to Egress sinks."""

    def __init__(self):
        self.store = TradeStore()
        self.clearing_client = ClearingHouseClient()

    def process_trade(self, trade_payload: dict) -> str:
        trade_id = str(uuid.uuid4())
        symbol = trade_payload.get("symbol", "AAPL")
        price = trade_payload.get("price", 150.0)
        quantity = trade_payload.get("quantity", 10.0)

        # 1. Egress: Store trade in SQL database
        self.store.save_trade(trade_id, symbol, price, quantity)

        # 2. Egress: Submit to external clearing house
        self.clearing_client.submit_trade_for_clearing({
            "trade_id": trade_id,
            "symbol": symbol,
            "amount": price * quantity
        })

        return trade_id

    def handle_market_tick(self, tick_data: bytes):
        print(f"Processing market tick: {tick_data}")

    def lookup_trade(self, trade_id: str):
        return self.store.get_trade(trade_id)
