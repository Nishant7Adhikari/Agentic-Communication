import networkInterfaces from "os";

const interfaces = networkInterfaces.networkInterfaces();
console.log("\n==========================================");
console.log(" Local Device Network IP Addresses");
console.log("==========================================");

let found = false;
for (const devName in interfaces) {
  const iface = interfaces[devName];
  for (const alias of iface || []) {
    if (alias.family === "IPv4" && !alias.internal) {
      console.log(` Interface: ${devName.padEnd(15)} -> http://${alias.address}:5000`);
      found = true;
    }
  }
}

if (!found) {
  console.log(" Local address: http://localhost:5000");
}
console.log("==========================================\n");
