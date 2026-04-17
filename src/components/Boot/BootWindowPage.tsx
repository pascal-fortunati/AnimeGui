import { useEffect } from "react";
import appLogo from "../../assets/logo_up.png";
import { Spinner } from "../ui/spinner";
import { t } from "../../i18n";

export function BootWindowPage() {
    useEffect(() => {
        document.documentElement.classList.add("boot-html");
        document.body.classList.add("boot-body");
        return () => {
            document.documentElement.classList.remove("boot-html");
            document.body.classList.remove("boot-body");
        };
    }, []);

    return (
        <main className="launch-screen">
            <div className="launch-content">
                <div className="launch-logo-shell">
                    <img className="launch-logo" src={appLogo} alt="AnimeGui" />
                </div>
                <div className="launch-footer">
                    <Spinner className="size-8 launch-spinner" />
                    <span className="launch-hint">{t("boot.loading")}</span>
                </div>
            </div>
        </main>
    );
}
