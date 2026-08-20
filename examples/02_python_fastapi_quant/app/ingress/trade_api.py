from fastapi import FastAPI, HTTPException
from app.service.trade_executor import TradeExecutor

app = FastAPI(title="Quant Trade API")
executor = TradeExecutor()

@app.post("/api/v1/trades/execute")
async def execute_trade(trade_payload: dict):
    """Ingress: REST API entry point for trade orders."""
    result = executor.process_trade(trade_payload)
    return {"status": "SUCCESS", "trade_id": result}

@app.get("/api/v1/trades/{trade_id}")
async def get_trade(trade_id: str):
    """Ingress: REST API entry point for trade queries."""
    trade = executor.lookup_trade(trade_id)
    if not trade:
        raise HTTPException(status_code=404, detail="Trade not found")
    return trade
