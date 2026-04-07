class Animal {
  constructor(name) { this.name = name; this.validate(name); }
  validate(name) { if (!name) throw new Error('required'); }
  speak() { return this.sound(); }
  sound() { return '...'; }
}

class Rat extends Animal {
  sound() { return '*rat noise*'; }
  fetch(item) { this.speak(); return this.retrieve(item); }
  retrieve(item) { return item; }
}

function train(animal, command) {
  const result = execute_command(animal, command);
  log_training(command, result);
  return result;
}

function execute_command(animal, command) {
  if (command === 'speak') return animal.speak();
  return null;
}

function log_training(command, result) { format_log(command, result); }

function format_log(command, result) { return `${command}: ${result}`; }
