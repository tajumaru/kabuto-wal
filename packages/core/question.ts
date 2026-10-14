export function isCauseQuestion(question: string) {
  return /なぜ|何故|なんで|何で|どうして|原因|理由|影響|から|せい|ため|連動/.test(question);
}
