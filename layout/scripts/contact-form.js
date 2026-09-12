(function () {
    "use strict";

    var form = document.getElementById("contact-form");
    var description = document.getElementById("contact-description");
    var counter = document.getElementById("contact-word-count");
    var success = document.getElementById("contact-form-success");
    if (!form || !description || !counter) return;

    var wordLimit = Number(description.getAttribute("data-word-limit"));
    var submitButton = form.querySelector('button[type="submit"]');

    function countWords(value) {
        var trimmed = value.trim();
        return trimmed ? trimmed.split(/\s+/u).length : 0;
    }

    function updateWordCount() {
        var count = countWords(description.value);
        var exceeded = count > wordLimit;
        counter.textContent = "Liczba słów: " + count + " / " + wordLimit;
        counter.classList.toggle("limit-exceeded", exceeded);
        description.setCustomValidity(exceeded ? "Opis może zawierać maksymalnie 1000 słów." : "");
        return !exceeded;
    }

    description.addEventListener("input", updateWordCount);
    form.addEventListener("submit", function (event) {
        updateWordCount();
        if (!form.checkValidity()) {
            event.preventDefault();
            form.reportValidity();
            return;
        }
        submitButton.disabled = true;
        submitButton.textContent = "Wysyłanie…";
    });
    updateWordCount();

    if (success && new URLSearchParams(window.location.search).get("sent") === "1") {
        success.hidden = false;
        success.focus();
    }
}());
