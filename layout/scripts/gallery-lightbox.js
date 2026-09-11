(function () {
    "use strict";

    var gallery = document.getElementById("gallery");
    var lightbox = document.getElementById("gallery-lightbox");
    if (!gallery || !lightbox) return;

    var image = lightbox.querySelector("img");
    var counter = lightbox.querySelector(".gallery-lightbox-counter");
    var closeButton = lightbox.querySelector(".gallery-lightbox-close");
    var previousButton = lightbox.querySelector(".gallery-lightbox-previous");
    var nextButton = lightbox.querySelector(".gallery-lightbox-next");
    var controls = [closeButton, previousButton, nextButton];
    var currentIndex = 0;
    var returnFocus = null;

    function getLinks() {
        return Array.prototype.slice.call(gallery.querySelectorAll(".gallery-grid a"));
    }

    function show(index) {
        var links = getLinks();
        if (!links.length) return;
        currentIndex = (index + links.length) % links.length;
        var thumbnail = links[currentIndex].querySelector("img");
        image.src = links[currentIndex].href;
        image.alt = thumbnail ? thumbnail.alt : "";
        counter.textContent = "Zdjęcie " + (currentIndex + 1) + " z " + links.length;
    }

    function open(index, trigger) {
        returnFocus = trigger;
        show(index);
        lightbox.hidden = false;
        document.body.classList.add("gallery-lightbox-open");
        closeButton.focus();
    }

    function close() {
        lightbox.hidden = true;
        image.removeAttribute("src");
        document.body.classList.remove("gallery-lightbox-open");
        if (returnFocus) returnFocus.focus();
    }

    gallery.addEventListener("click", function (event) {
        var link = event.target.closest(".gallery-grid a");
        if (!link || !gallery.contains(link)) return;
        var index = getLinks().indexOf(link);
        if (index < 0) return;
        event.preventDefault();
        open(index, link);
    });

    closeButton.addEventListener("click", close);
    previousButton.addEventListener("click", function () { show(currentIndex - 1); });
    nextButton.addEventListener("click", function () { show(currentIndex + 1); });
    lightbox.addEventListener("click", function (event) {
        if (event.target === lightbox) close();
    });

    document.addEventListener("keydown", function (event) {
        if (lightbox.hidden) return;

        if (event.key === "Escape") {
            event.preventDefault();
            close();
        } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            show(currentIndex - 1);
        } else if (event.key === "ArrowRight") {
            event.preventDefault();
            show(currentIndex + 1);
        } else if (event.key === "Tab") {
            var first = controls[0];
            var last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    });
}());
