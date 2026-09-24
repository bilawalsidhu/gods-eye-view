try:
    from PIL import Image, ImageDraw
    print("PIL available")
except ImportError as e:
    print("PIL not available:", e)