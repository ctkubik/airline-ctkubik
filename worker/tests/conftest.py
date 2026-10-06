import os
import sys

# Import worker modules the same way worker.py does (`from lib.x import ...`).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
