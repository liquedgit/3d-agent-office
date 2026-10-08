"""Seed the office (also callable directly)."""
from db import init_db, seed_defaults

init_db()
seeded = seed_defaults()
print("Seeded 7 agents." if seeded else "Office already populated.")
