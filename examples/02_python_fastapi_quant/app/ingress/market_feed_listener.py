import asyncio
from aiokafka import AIOKafkaConsumer
from app.service.trade_executor import TradeExecutor

class MarketFeedListener:
    """Ingress: Async Kafka message queue consumer for market tick events."""

    def __init__(self, executor: TradeExecutor):
        self.executor = executor

    async def start_listening(self):
        consumer = AIOKafkaConsumer(
            "market.ticks.inbound",
            bootstrap_servers="localhost:9092",
            group_id="quant-risk-group"
        )
        await consumer.start()
        try:
            async for msg in consumer:
                self.executor.handle_market_tick(msg.value)
        finally:
            await consumer.stop()
