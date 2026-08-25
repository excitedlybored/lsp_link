from sqlalchemy import create_engine, Column, String, Float
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

Base = declarative_base()

class TradeRecord(Base):
    __tablename__ = "trades"
    id = Column(String, primary_key=True)
    symbol = Column(String)
    price = Column(Float)
    quantity = Column(Float)

class TradeStore:
    """Egress: Database persistence sink using SQLAlchemy ORM."""

    def __init__(self):
        self.engine = create_engine("sqlite:///trades.db")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)

    def save_trade(self, trade_id: str, symbol: str, price: float, quantity: float):
        session = self.Session()
        record = TradeRecord(id=trade_id, symbol=symbol, price=price, quantity=quantity)
        session.add(record)
        session.commit()
        session.close()

    def get_trade(self, trade_id: str):
        session = self.Session()
        record = session.query(TradeRecord).filter_by(id=trade_id).first()
        session.close()
        return record
