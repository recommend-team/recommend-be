import { buildDiscoveryPrompt } from './prompt';

describe('the discovery prompt', () => {
  const prompt = buildDiscoveryPrompt('James');

  it('gives the assistant its name, and lets it say so', () => {
    expect(prompt).toContain('You are James');
    expect(prompt).toContain(
      'If someone asks your name or who you are, tell them',
    );
  });

  it('takes the name from configuration', () => {
    expect(buildDiscoveryPrompt('Ada')).toContain('Your name is Ada');
    expect(buildDiscoveryPrompt('Ada')).not.toContain('James');
  });

  it('never lets it claim to be human, if sincerely asked', () => {
    expect(prompt).toContain('Never claim to be human');
    expect(prompt).toContain("Recommend's virtual assistant");
  });

  it('keeps the teammate tool away from small talk and questions about itself', () => {
    // The screenshot this exists for: "what is your name?" was handed to an admin.
    expect(prompt).toMatch(
      /NEVER for greetings, small talk, questions about you or your name/,
    );
  });

  it('tells the model to answer every question, and to ask when unsure', () => {
    expect(prompt).toContain('Answer every question the buyer asks');
    expect(prompt).toContain('ask one short question to clarify');
  });

  it('keeps the rules that protect money and the catalogue', () => {
    expect(prompt).toContain('NEVER state a price');
    expect(prompt).toContain('Never invent a vendor, an item');
  });
});
