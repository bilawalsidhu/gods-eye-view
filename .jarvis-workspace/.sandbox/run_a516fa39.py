def is_prime(n):
    """Return True if n is a prime number, False otherwise."""
    if n <= 1:
        return False
    if n <= 3:
        return True
    if n % 2 == 0 or n % 3 == 0:
        return False
    i = 5
    w = 2
    while i * i <= n:
        if n % i == 0:
            return False
        i += w
        w = 6 - w
    return True

# Test cases
for num in [1, 2, 3, 4, 5, 16, 17, 19, 20, 23, 29, 97, 100, 101, 104729]:
    print(f"{num}: {is_prime(num)}")
