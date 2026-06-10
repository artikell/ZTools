// 当前按下的修饰键
export type CommonKeyboardModifier = 'shift' | 'ctrl' | 'alt' | 'meta'

// 将 KeyboardEvent 中的修饰键转换成 Electron.KeyboardEvent 键盘事件中的修饰键
export function readModifiers(event: KeyboardEvent): CommonKeyboardModifier[] {
  const modifiers: CommonKeyboardModifier[] = []

  if (event.shiftKey) {
    modifiers.push('shift')
  }

  if (event.ctrlKey) {
    modifiers.push('ctrl')
  }

  if (event.altKey) {
    modifiers.push('alt')
  }

  if (event.metaKey) {
    modifiers.push('meta')
  }

  return modifiers
}
