class Animal:
    def __init__(self, name):
        self.name = name
        self.validate(name)

    def validate(self, name):
        if not name:
            raise ValueError("required")

    def speak(self):
        return self.sound()

    def sound(self):
        return "..."

class Dog(Animal):
    def sound(self):
        return "Woof"

    def fetch(self, item):
        self.speak()
        return self.retrieve(item)

    def retrieve(self, item):
        return item

class Cat(Animal):
    def sound(self):
        return "Meow"

    def purr(self):
        self.speak()

def train(animal, command):
    result = execute_command(animal, command)
    log_training(command, result)
    return result

def execute_command(animal, command):
    if command == "speak":
        return animal.speak()
    return None

def log_training(command, result):
    format_log(command, result)

def format_log(command, result):
  return f"{command}: {result}"
