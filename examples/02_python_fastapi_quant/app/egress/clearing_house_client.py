import requests

class ClearingHouseClient:
    """Egress: Outbound HTTP Client to external clearing house."""

    def __init__(self, base_url: str = "https://api.clearinghouse.bank/v1"):
        self.base_url = base_url

    def submit_trade_for_clearing(self, trade_data: dict) -> dict:
        url = f"{self.base_url}/clearing/submit"
        response = requests.post(url, json=trade_data, timeout=5)
        return response.json()
