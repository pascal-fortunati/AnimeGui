import * as SwitchPrimitive from "@radix-ui/react-switch"

interface SwitchProps {
  checked: boolean
  onCheckedChange?: (value: boolean) => void
  disabled?: boolean
}

export function Switch({ checked, onCheckedChange, disabled }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className="switch-root"
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange ?? (() => { })}
    >
      <SwitchPrimitive.Thumb className="switch-thumb" />
    </SwitchPrimitive.Root>
  )
}
