def format_log(command, result):
    return f"{command}: {result}"

def log_training(command, result):
    format_log(command, result)

def execute_command(animal, command):
    if command == "speak":
        return animal.speak()
    return None
