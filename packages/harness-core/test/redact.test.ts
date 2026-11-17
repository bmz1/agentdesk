import { describe, expect, it } from "@effect/vitest"
import { redactDeep, redactSecrets } from "../src"

describe("redaction", () => {
  it("masks common credential formats but keeps normal text", () => {
    const text = [
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP",
      "Authorization: Bearer abcdef1234567890xyz",
      "password = hunter2hunter2",
      "glpat-abcdefghijklmnopqrstu",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
      "regular sentence about passwords in general"
    ].join("\n")
    const out = redactSecrets(text)
    expect(out).not.toMatch(/ghp_abc|AKIAABCD|abcdef1234567890xyz|hunter2|glpat-abc|MIIE/)
    expect(out).toContain("regular sentence about passwords in general")
    expect(redactDeep({ a: ["sk-ant-abcdefghijklmnopqrstuvwxyz12"], n: 1 })).toEqual({ a: ["[REDACTED API KEY]"], n: 1 })
  })
})
