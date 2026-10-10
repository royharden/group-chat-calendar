import { describe, expect, it } from "vitest";
import { parseChat } from "./chatParser";

describe("parseChat", () => {
  it("parses bracket-style WhatsApp exports", () => {
    const raw = "[10/3/26, 7:41 PM] Mom: Practice moved to next Tuesday at 5\n[10/3/26, 7:45 PM] Dad: ok";
    const res = parseChat(raw);
    expect(res.format).toBe("whatsapp-bracket");
    expect(res.messages).toHaveLength(2);
    expect(res.messages[0]).toMatchObject({ id: "M001", sender: "Mom" });
    expect(res.messages[0].text).toBe("Practice moved to next Tuesday at 5");
    expect(res.members).toEqual(["Dad", "Mom"]);
  });

  it("parses dash-style WhatsApp exports", () => {
    const raw = "10/3/26, 19:41 - Mom: hello\n10/3/26, 19:42 - Dad: hi";
    const res = parseChat(raw);
    expect(res.format).toBe("whatsapp-dash");
    expect(res.messages[0].sender).toBe("Mom");
    const d = new Date(res.messages[0].sent_at);
    expect(d.getUTCHours()).toBe(19);
  });

  it("parses plain Name: text lines with a first-message date", () => {
    const raw = "Mom: dentist tomorrow at 9:30\nDad: ok";
    const res = parseChat(raw, { firstMessageDate: "2026-10-05" });
    expect(res.format).toBe("plain");
    expect(res.messages[0].id).toBe("M001");
    expect(new Date(res.messages[0].sent_at).getUTCDate()).toBe(5);
  });

  it("keeps multi-line messages together", () => {
    const raw = "[10/3/26, 7:41 PM] Mom: first line\nsecond line\n[10/3/26, 7:42 PM] Dad: next";
    const res = parseChat(raw);
    expect(res.messages[0].text).toBe("first line\nsecond line");
    expect(res.messages[1].text).toBe("next");
  });
});
