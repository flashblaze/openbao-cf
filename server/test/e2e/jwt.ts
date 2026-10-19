// Test keypair + token signer. Usage:
//   bun test/e2e/jwt.ts keygen <dir>
//   bun test/e2e/jwt.ts sign <dir> <email>
import { exportJWK, exportSPKI, generateKeyPair, importJWK, SignJWT } from "jose";
import { join } from "node:path";

const [cmd, dir, email] = process.argv.slice(2);
if (!dir || (cmd !== "keygen" && cmd !== "sign") || (cmd === "sign" && !email)) {
  console.error("usage: jwt.ts keygen <dir> | sign <dir> <email>");
  process.exit(2);
}

if (cmd === "keygen") {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  await Bun.write(join(dir, "private.jwk"), JSON.stringify(await exportJWK(privateKey)));
  await Bun.write(join(dir, "public.pem"), await exportSPKI(publicKey));
} else {
  const jwk = JSON.parse(await Bun.file(join(dir, "private.jwk")).text());
  const key = await importJWK(jwk, "RS256");
  const jwt = await new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://test.cloudflareaccess.com")
    .setAudience(["test-aud"])
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
  console.log(jwt);
}
