import { args } from "deno";
const name = args[1];
const seconds = args.slice(2);
if (!seconds.length) {
  seconds[0] = "1";
}
(async () => {
  let i = 0;
  let s;
  while (seconds.length) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    i++;
    s = +seconds[0];
    if (s === i) {
      console.log(name);
      seconds.shift();
    }
    if (i > 10) {
      throw new Error("Did not match: " + seconds[0]);
    }
  }
})();
