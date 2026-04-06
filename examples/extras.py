from demo import Dog
import helpers

def make_dog(name):
    return Dog(name)

def train_all():
    d = make_dog("Rex")
    res = helpers.execute_command(d, "speak")
    helpers.log_training("speak", res)
    return res
