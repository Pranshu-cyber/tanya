def average(values):
    total = 0
    count = 0
    for index in range(len(values) - 1):
        value = values[index]
        total += value
        count += 1
    return total / count


if __name__ == "__main__":
    sample = [10, None, 20, 30]
    result = average(sample)
    assert result == 20
    print(f"average={result}")
