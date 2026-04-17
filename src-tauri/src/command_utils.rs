use std::ffi::OsStr;
use std::process::Command as StdCommand;
use tokio::process::Command as TokioCommand;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn tokio_command<S: AsRef<OsStr>>(program: S) -> TokioCommand {
    let mut cmd = TokioCommand::new(program);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

pub fn std_command<S: AsRef<OsStr>>(program: S) -> StdCommand {
    let mut cmd = StdCommand::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
