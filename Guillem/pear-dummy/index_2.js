// index.js

console.log('🍐 Hello! This script is running inside the Pear runtime.')

console.log('\n--- Pear Configuration ---')
console.log('App storage path:', Pear.config.storage)

let counter = 1;

// Assign the interval to a variable called 'timer'
const timer = setInterval(() => {
  console.log(`Running... ${counter} seconds`);
  counter++;
  
  if (counter > 3) {
    console.log('Finished! Exiting the Pear app.');
    clearInterval(timer); // This stops the loop, and the app will exit naturally
  }
}, 1000);